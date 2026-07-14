/**
 * Smarther 2 summer cooling-valve-open — idempotent.
 *
 * Physical context (Fabio's apartment, Milano):
 *   - 2-pipe hydronic system: same pipes carry hot water in winter (boiler)
 *     OR cold water in summer (condominio chiller). A manual seasonal switch
 *     in the building's central plant flips the source.
 *   - Smarther 2 (BTicino, Netatmo BNS API) sits between the apartment loop
 *     and the fancoils. It controls the zone valve that gates ALL water flow
 *     into the apartment.
 *
 * Smarther 2 cooling-mode logic (verified live against this house 2026-05-26):
 *   Home `temperature_control_mode === 'cooling'` MUST be set first via the
 *   Home + Control app (Settings → Schedules → drop-down → Cooling). Then
 *   each room exposes a `cooling_setpoint_*` triple separate from the
 *   heating one, and the firmware inverts the valve logic:
 *     - measured > cooling_setpoint → valve OPEN (chiama acqua fredda)
 *     - measured ≤ cooling_setpoint → valve CLOSED (stanza già fredda)
 *
 * Goal of this helper: keep the apartment-level zone valve PERMANENTLY
 * OPEN whenever season=cool, so the cold-water riser reaches every
 * fancoil regardless of how the Smarther feels. The Smarther sits in
 * the kitchen area, which shares the same open-space ambient as the
 * soggiorno (verified with Fabio 2026-05-26). Empirically it reads ~21°C
 * while the soggiorno reads ~28°C — the cooler reading is probably the
 * Smarther probe sitting near a cool wall or in the natural airflow
 * between rooms. In cooling mode the firmware would close the valve as
 * soon as its own measured temp falls below the user's scheduled cooling
 * setpoint, starving every Sabiana fancoil downstream. The manual
 * override at cooling_setpoint=16 forces the firmware to perpetually
 * call for cool.
 *
 * Strategy: push the Smarther's COOLING setpoint to 16°C manual, 180 days.
 * 16°C is below any realistic Milano indoor temperature; Smarther will
 * perpetually "want more cooling", valve stays open, fancoils handle
 * per-room throttling downstream via Sabiana mode/setpoint/fan.
 *
 * Endtime: 180 days, same window as the bathroom antifreeze helper.
 * Covers Milan's full cooling season (mid-May → end of September) with
 * margin. The user can always force `season='heat'` or `season='off'` to
 * clear it earlier.
 *
 * Refresh: every 60 minutes. Why this is aggressive on purpose: if Fabio
 * touches the Smarther from the BTicino app, or someone nudges a wall
 * panel, the manual override is replaced by 'home' (schedule) mode. With
 * schedule mode active the firmware uses the user's scheduled cooling
 * setpoint (typically 24-25°C) and closes the valve as soon as soggiorno
 * crosses it — starving every fancoil. A 60-min refresh corrects a stray
 * change within an hour without spamming Netatmo.
 *
 * Idempotency via `state.smartherSummerOpenAt`:
 *   - null → not yet applied → call Netatmo
 *   - timestamp set → already applied → no-op (unless older than REFRESH)
 *
 * Caller responsibility: clear `smartherSummerOpenAt` to null when
 * season returns to 'heat' so the next cool transition re-arms cleanly.
 *
 * NOTE: this helper does NOT switch the home's temperature_control_mode
 * itself — that switch is NOT exposed in the Netatmo Connect API public
 * surface (see docs/SMARTHER-COOL-SWITCH-PROTOCOL.md). The user must
 * flip heating ↔ cooling once per season inside Home + Control. Once
 * the home is in cooling mode, this helper handles the rest.
 */

import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { setRoomCoolingState, setRoomState } from '@/lib/netatmo/client';
import { loadNetatmoContext } from '@/lib/netatmo/context';
import type { AgentState } from '@/lib/agent/state';

/**
 * Manual cooling setpoint chosen so measured > setpoint is ALWAYS true.
 * 16°C is below the lowest realistic indoor temperature in any Milano
 * apartment, even with the chiller running flat-out — verified live
 * 2026-05-26 (soggiorno 21.3°C at midnight with chiller active).
 */
const SUMMER_COOLING_SETPOINT = 16;
const SUMMER_OPEN_ENDTIME_SEC = 180 * 24 * 60 * 60;
/** 60-min refresh — see file-header rationale. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;
/** Smarther 2 room is mapped under either 'soggiorno' or 'termostato'. */
const THERMOSTAT_ROOM_KEYS = ['soggiorno', 'termostato'] as const;

export interface SummerOpenOutcome {
  applied: boolean;
  reason: string;
  setpoint?: number;
}

export async function ensureSmartherSummerOpen(
  state: AgentState,
  now: number = Date.now(),
): Promise<SummerOpenOutcome> {
  const last = state.smartherSummerOpenAt ?? null;
  if (last !== null && now - last < REFRESH_AFTER_MS) {
    return { applied: false, reason: 'already_open' };
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { applied: false, reason: 'no_netatmo_token' };
  }

  let homeId: string;
  let roomMap: Record<string, string>;
  try {
    const ctx = await loadNetatmoContext();
    if (!ctx.homeId) return { applied: false, reason: 'no_netatmo_home' };
    homeId = ctx.homeId;
    roomMap = ctx.roomMap ?? {};
  } catch (e) {
    return {
      applied: false,
      reason: `ctx_failed:${e instanceof Error ? e.message : 'unknown'}`,
    };
  }

  let thermostatRoomId: string | null = null;
  for (const key of THERMOSTAT_ROOM_KEYS) {
    if (roomMap[key]) {
      thermostatRoomId = roomMap[key];
      break;
    }
  }
  if (!thermostatRoomId) {
    return { applied: false, reason: 'no_thermostat_room_map' };
  }

  const endtime = Math.floor(now / 1000) + SUMMER_OPEN_ENDTIME_SEC;
  try {
    await setRoomCoolingState(
      accessToken,
      homeId,
      thermostatRoomId,
      'manual',
      SUMMER_COOLING_SETPOINT,
      endtime,
    );
    state.smartherSummerOpenAt = now;
    return { applied: true, reason: 'opened', setpoint: SUMMER_COOLING_SETPOINT };
  } catch (e) {
    return {
      applied: false,
      reason: `open_failed:${e instanceof Error ? e.message.slice(0, 60) : 'err'}`,
    };
  }
}

/**
 * Global-OFF counterpart of ensureSmartherSummerOpen — release the Smarther
 * zone-valve override so it is no longer forced perpetually open.
 *
 * When the user flips season to 'off' (leaving home, or the building-loop
 * interregno), we want the apartment-level zone valve to go neutral, not stay
 * pinned open by a stale summer override. Releasing the override back to
 * 'home' (schedule) mode does exactly that: the firmware reverts to the user's
 * heating/cooling schedule and closes the valve under normal logic. Combined
 * with all fancoils being shut off, the apartment stops drawing from the riser.
 *
 * Idempotent via `state.smartherClosedAt`:
 *   - null → not yet released this off-transition → call Netatmo
 *   - timestamp set → already released → no-op (refresh after REFRESH_AFTER_MS)
 *
 * Caller responsibility: clear `smartherClosedAt` to null whenever
 * season !== 'off' so the next off-transition re-arms.
 *
 * We release BOTH the cooling override (back to schedule) — covering the
 * common case where off follows summer. setRoomState('home') with no temp is
 * the documented "restore schedule" call (see netatmo/client.ts setRoomState).
 */
export async function ensureSmartherClosed(
  state: AgentState,
  now: number = Date.now(),
): Promise<SummerOpenOutcome> {
  const last = state.smartherClosedAt ?? null;
  if (last !== null && now - last < REFRESH_AFTER_MS) {
    return { applied: false, reason: 'already_closed' };
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { applied: false, reason: 'no_netatmo_token' };
  }

  let homeId: string;
  let roomMap: Record<string, string>;
  try {
    const ctx = await loadNetatmoContext();
    if (!ctx.homeId) return { applied: false, reason: 'no_netatmo_home' };
    homeId = ctx.homeId;
    roomMap = ctx.roomMap ?? {};
  } catch (e) {
    return {
      applied: false,
      reason: `ctx_failed:${e instanceof Error ? e.message : 'unknown'}`,
    };
  }

  let thermostatRoomId: string | null = null;
  for (const key of THERMOSTAT_ROOM_KEYS) {
    if (roomMap[key]) {
      thermostatRoomId = roomMap[key];
      break;
    }
  }
  if (!thermostatRoomId) {
    return { applied: false, reason: 'no_thermostat_room_map' };
  }

  try {
    // 'home' restores the schedule and drops any manual override — the valve
    // goes back to normal firmware logic instead of being held open.
    await setRoomState(accessToken, homeId, thermostatRoomId, 'home');
    state.smartherClosedAt = now;
    return { applied: true, reason: 'released_to_schedule' };
  } catch (e) {
    return {
      applied: false,
      reason: `close_failed:${e instanceof Error ? e.message.slice(0, 60) : 'err'}`,
    };
  }
}
