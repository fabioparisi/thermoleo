/**
 * Campomarino per-room executor (MELCloud splits).
 *
 * Mirrors the Milano cool/heat hysteresis state machine in `state-machine.ts`
 * but actuates via MELCloud `setAta` instead of Sabiana. Deliberately a SEPARATE
 * function (not a refactor of `processRoom`) so Milano's body stays byte-identical
 * — the boards' Tier-1 recommendation. It REUSES the pure decision helpers
 * (computeSetpoint/computeFanSpeed/checkSafetyInvariants) so the
 * control law never drifts from Milano's.
 *
 * NOTE: unlike Milano, Campomarino has NO hourly rate limits and NO min-on/min-off
 * dwell (Fabio 2026-06-21) — a seasonal-only split must chase the UI target on
 * every cycle; the dwell/cap could lock Nursery's room out of cooling for up to 1h.
 * Only the +0.3°C dead-band (above target; Campomarino-specific, vs Milano's
 * ±0.5) gates transitions.
 *
 * Differences from the Sabiana path, all required:
 *  - setAta replaces sendSabianaCmd; the MELCloud client owns its own auth.
 *  - computeSetpoint returns the REAL target for melcloud (no T1-bias floor).
 *  - Mode: 'cool' by default (Fabio 2026-07-11; was 'dry' until then). A manual
 *    'dry' pin from the UI still works, but auto-cool overrides it past
 *    HARD_COOL_GAP (baby-room rule).
 *  - Fan NORMALIZATION: the device reports a MELCloud fan enum (0=auto,255=silent,
 *    1-5); we normalize it into the 1-3 ladder space BEFORE storing rs.lastFan,
 *    or `fanChanged` would thrash and re-send setAta every cycle (board D1).
 */

import { getRoomState, type AgentState, type ControlState } from '@/lib/agent/state';
import { SENSOR_FAULT_THRESHOLD, checkSafetyInvariants, type RoomConfig } from '@/lib/agent/safety';
import { supaInsert } from '@/lib/supabase/rest';
import { setAta, getDevice } from '@/lib/melcloud/client';
import type { MelDeviceState } from '@/lib/melcloud/types';
import {
  computeSetpoint,
  sendAlert,
  HISTORY_WINDOW,
} from '@/lib/agent/state-machine';

/** Vertical vane position per room (ClassicVertical: 1=upwards, 5=downwards).
 *  Nursery's rooms (camera/studio) keep 1 (upwards, gentle over the crib); the
 *  soggiorno blows downwards (Fabio 2026-06-30). Default for any room not listed
 *  is upwards (1). */
const VANE_BY_ROOM: Record<string, number> = { campomarino_soggiorno: 5 };

/** Gap (°C) above target at which auto-cool escalation OVERRIDES even a manual
 *  'dry' pin. A baby room must not stay hot because a parent chose the gentle
 *  mode and dry can't pull it down on a peak day. (Fabio 2026-06-23: manual dry
 *  wins inside the comfort band, auto-cool wins past this gap, safety_max above
 *  all.) */
export const HARD_COOL_GAP = 3;

/** Default fan for Campomarino splits = the lowest non-silent rung (Fabio
 *  2026-06-21: always start at minimum, raise from the UI when wanted). */
export const DEFAULT_FAN = 1;

/** Silent fan rung (the remote's "silenzioso"). Internal ladder value 0; maps
 *  to MEL_FAN.silent (255) at the setAta boundary. */
export const SILENT_FAN = 0;

/**
 * Automatic actuation mode for a Campomarino split (no manual override):
 * 'cool' always (Fabio 2026-07-11 — was dry-first with a 0.5°C cool-escalation
 * gap until then). 'dry' remains reachable only as a manual UI pin.
 */
export function chooseMode(): 'cool' | 'dry' {
  return 'cool';
}

/**
 * Resolve the mode to actuate, honouring a manual UI override with a safety
 * escalation. Precedence (Fabio 2026-06-23, board Opus+GLM, baby-room rule):
 *   safety_max (forces ON elsewhere) > AUTO-COOL escalation > manualMode > auto.
 *  - A manual 'cool' or 'dry' wins inside the comfort band.
 *  - BUT if temp climbs ≥ HARD_COOL_GAP (3°C) above target, force 'cool' even
 *    over a manual 'dry' — dry can't cool a baby room down on a peak day. The
 *    UI shows an AUTO-COOL badge so the override is visible (escalated===true).
 *  - No manual pin → the automatic chooseMode (always 'cool').
 * Returns the mode AND whether escalation overrode a manual choice (for the log
 * + UI badge).
 */
export function resolveMode(
  manualMode: 'cool' | 'dry' | null | undefined,
  temp: number | null,
  target: number | null,
): { mode: 'cool' | 'dry'; escalated: boolean } {
  const hot = temp !== null && target !== null && Number.isFinite(temp) && Number.isFinite(target)
    && temp - target >= HARD_COOL_GAP;
  if (manualMode === 'cool' || manualMode === 'dry') {
    if (manualMode === 'dry' && hot) return { mode: 'cool', escalated: true };
    return { mode: manualMode, escalated: false };
  }
  return { mode: chooseMode(), escalated: false };
}

/**
 * Normalize a MELCloud fan enum (0=auto, 255=silent, 1-5) into the agent's
 * INTERNAL ladder space 0-3 (0=silent, 1=slow, 2=mid, 3=fast), so the
 * device-resync's rs.lastFan compares apples-to-apples with the fan we last
 * sent. CRITICAL: silent (255) maps to its OWN rung 0, NOT collapsed to 1 —
 * otherwise pinning silent and re-reading 255 would look like "1 ≠ 255-as-1"
 * inconsistencies and thrash setAta every cycle. (Fabio 2026-06-23.)
 */
export function normalizeFan(melFan: number | null): number {
  if (melFan === null || !Number.isFinite(melFan)) return 2; // unknown → mid ladder
  if (melFan === 255) return SILENT_FAN; // silent → dedicated rung 0 (NOT 1)
  if (melFan === 0) return 2;     // device-auto → treat as mid
  if (melFan <= 1) return 1;
  if (melFan >= 3) return 3;
  return 2;
}

/**
 * Translate an internal fan rung (0-3) into the abstract fan the MELCloud client
 * accepts ('silent' | 1..3). Rung 0 = the remote's silent (255). Numeric rungs
 * pass through. (The client's resolveFan does the final 'silent'→255 mapping.)
 */
export function toAbstractFan(rung: number): 'silent' | number {
  return rung === SILENT_FAN ? 'silent' : rung;
}

export interface SplitRoomInput {
  roomId: string;
  state: AgentState;
  config: RoomConfig;        // apiSource='melcloud', target = the UI per-room target
  dev: MelDeviceState | undefined; // the split's current state (undefined if MELCloud was unreachable)
  /** Authoritative room temp, ALREADY resolved by the cycle (Shelly real-air >
   *  split+bias > null). processSplitRoom MUST use this for every decision — it
   *  does NOT re-derive temp from dev.roomTemperature (that's the cold return-air
   *  probe, ~1.5°C low, which silently ignored the Shelly feed). (Fabio 2026-06-21.) */
  temp: number | null;
  /** Independent humidity reading (Shelly) when available; null until then. */
  humidity: number | null;
  addLog: (msg: string) => void;
}

/**
 * Process one Campomarino split for one cycle. Read → decide (shared helpers) →
 * actuate via setAta, gated by the same rate-limits + MIN_ON/OFF dwell as Milano.
 * Season is always 'cool' for now (summer); the heat path is symmetric and lands
 * when the family overwinters.
 */
export async function processSplitRoom(input: SplitRoomInput): Promise<void> {
  const { roomId, state, config, dev, temp: inputTemp, addLog } = input;
  const rs = getRoomState(state, roomId);
  const season = 'cool' as const;

  const buildingId = dev?.buildingId;
  const deviceId = Number(config.deviceId);
  if (!Number.isSafeInteger(deviceId)) {
    addLog(`${roomId}: invalid device_id '${config.deviceId}' — skipped`);
    return;
  }

  // Temp is the AUTHORITATIVE value the cycle already resolved (Shelly real-air >
  // split+bias). Do NOT re-derive from dev.roomTemperature here — that's the cold
  // return-air probe that made the Shelly feed cosmetic (rooms hot but agent saw
  // ~1.5°C low → never cooled). Re-gate plausibility (5..45) defensively; null →
  // SENSOR_FAULT path below. (Fabio 2026-06-21, board Opus+GLM.)
  const temp =
    inputTemp !== null && Number.isFinite(inputTemp) && inputTemp > 5 && inputTemp < 45
      ? inputTemp
      : null;

  // ── DEVICE RESYNC (normalize fan into ladder space — board D1) ──
  // rs.lastMode must hold the SAME vocabulary the agent commands ('heat'|'cool'|
  // 'dry'|'off'), or modeChanged thrashes: a split in dry (operationMode=2) must
  // resync to 'dry', not 'cool', else `'cool' !== onMode('dry')` re-asserts every
  // cycle and burns the MELCloud rate-limit.
  if (dev) {
    rs.lastSetpoint = typeof dev.setTemperature === 'number' ? dev.setTemperature : rs.lastSetpoint;
    // ListDevices reports SetFanSpeed=null for these splits (only Device/Get
    // populates it). normalizeFan(null) would invent a value (2) that never
    // matches computeFanSpeed (1) → fanChanged thrashes a re-assert EVERY cycle,
    // burning the MELCloud rate-limit. So ONLY resync lastFan when the device
    // actually reports a fan; otherwise keep the last value we sent.
    if (dev.fanSpeed !== null && Number.isFinite(dev.fanSpeed)) {
      rs.lastFan = normalizeFan(dev.fanSpeed);
    }
    rs.lastMode = !dev.power
      ? 'off'
      : dev.operationMode === 1 ? 'heat'
      : dev.operationMode === 2 ? 'dry'
      : 'cool'; // 3=cool, and any other cooling-output mode
  }

  // History + null counter (drives SENSOR_FAULT + trend).
  if (temp !== null) {
    rs.consecutiveNullReadings = 0;
    rs.history.push({ temp, timestamp: Date.now() });
    if (rs.history.length > HISTORY_WINDOW) rs.history.shift();
  } else {
    rs.consecutiveNullReadings++;
  }
  const oneHourAgo = Date.now() - 3600_000;
  rs.commandTimestamps = rs.commandTimestamps.filter(t => t > oneHourAgo);
  rs.modeChangeTimestamps = rs.modeChangeTimestamps.filter(t => t > oneHourAgo);

  // ON mode: a manual UI override (cool/dry) wins inside the comfort band, but
  // auto-cool escalation overrides a manual 'dry' past HARD_COOL_GAP (baby room
  // must not stay hot). No manual pin → automatic chooseMode. OFF is always off.
  const { mode: onMode, escalated: coolEscalated } = resolveMode(rs.manualMode, temp, config.target);

  /** The internal fan rung to use for an ON command. A manual UI pin wins; with NO
   *  pin the default is PER-MODE (Fabio 2026-06-30): dry → silent (the quiet
   *  default), cool → DEFAULT_FAN (rung 1, the lowest non-silent = "cool min"). */
  const fanRung = (mode: 'cool' | 'dry'): number =>
    rs.manualFan ?? (mode === 'dry' ? SILENT_FAN : DEFAULT_FAN);

  /** Resolve the fan to send for an ON command. Guard (board GLM): silent + dry
   *  dehumidifies almost nothing (minimal airflow × dry's weak exchange) — in dry,
   *  coerce silent up to rung 1 so a baby room never sits on a no-op. Translate to
   *  the client's abstract fan. */
  const resolveAbstractFan = (mode: 'cool' | 'dry'): 'silent' | number => {
    let rung = fanRung(mode);
    if (mode === 'dry' && rung === SILENT_FAN) rung = 1; // silent+dry → no-op, bump to slow
    return toAbstractFan(rung);
  };

  /** Send a setAta command, THEN read the device back to confirm the state change
   *  actually took (Fabio 2026-06-21: every state change must be verified — never
   *  assume the command landed; MELCloud commands silently no-op under latency or
   *  if the unit rejects them). On a verified mismatch we retry once, then give up
   *  and return false so the agent does NOT record a state it didn't achieve.
   *  ON always uses `onMode`; OFF means power off. */
  const VERIFY_DELAY_MS = 2500;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const sendOnce = async (kind: 'on' | 'off', mode: 'dry' | 'cool', setpoint: number, fan: 'silent' | number) => {
    if (kind === 'off') {
      await setAta(deviceId, buildingId ?? 0, { power: false, mode: 'off' }, dev);
    } else {
      await setAta(
        deviceId, buildingId ?? 0,
        { power: true, mode, temperature: setpoint, fan, vaneVertical: VANE_BY_ROOM[roomId] ?? 1 },
        dev,
      );
    }
  };

  /** Read the device back and check it actually reached the wanted state. For OFF:
   *  power must be false. For ON: power true AND a cooling-output mode (dry=2 or
   *  cool=3, never heat=1) — "power on but stuck in heat" is NOT a verified cool
   *  (board Opus+GLM). Returns null when the read fails (unverified, not success). */
  const verifyState = async (wantOn: boolean): Promise<boolean | null> => {
    try {
      const fresh = await getDevice(deviceId, buildingId ?? 0);
      if (fresh.power === null) return null;
      if (!wantOn) return fresh.power === false;
      const coolingMode = fresh.operationMode === 2 || fresh.operationMode === 3;
      return fresh.power === true && coolingMode;
    } catch {
      return null;
    }
  };

  const actuate = async (
    kind: 'on' | 'off',
    prevState: ControlState,
    reason: string,
  ): Promise<boolean> => {
    const mode = onMode;
    const setpoint = computeSetpoint(roomId, temp ?? config.target, config, season);
    // `rung` is the INTERNAL ladder value (0-3) we persist to rs.lastFan (compared
    // against normalizeFan next cycle); `abstractFan` is what the client wants
    // ('silent'|1..3). Keep them distinct or lastFan drifts and fanChanged thrashes.
    // MUST mirror resolveAbstractFan's silent+dry→1 bump, or lastFan reads as a
    // permanent mismatch and re-fires every cycle.
    let rung = fanRung(mode);
    if (mode === 'dry' && rung === SILENT_FAN) rung = 1;
    const abstractFan = resolveAbstractFan(mode);
    const wantOn = kind === 'on';
    try {
      await sendOnce(kind, mode, setpoint, abstractFan);
      // Verify the change took. If it didn't (and the read succeeded), retry once.
      await sleep(VERIFY_DELAY_MS);
      let verified = await verifyState(wantOn);
      if (verified === false) {
        addLog(`${roomId}: ${kind} NOT confirmed (device still ${wantOn ? 'OFF' : 'ON'}) — retrying`);
        await sendOnce(kind, mode, setpoint, abstractFan);
        await sleep(VERIFY_DELAY_MS);
        verified = await verifyState(wantOn);
      }
      if (verified === false) {
        addLog(`${roomId}: ${kind} FAILED to confirm after retry — device did not obey`);
        return false; // do NOT record a state we didn't reach
      }
      // Bookkeeping (timestamps + action row) always runs once we've sent.
      rs.lastCommandCycle = state.cycleCount;
      rs.commandTimestamps.push(Date.now());
      rs.modeChangeTimestamps.push(Date.now());
      supaInsert('agent_actions', [{
        room_id: roomId, property_id: 'campomarino', action_type: 'mode_change',
        old_value: prevState,
        new_value: kind === 'off' ? 'off' : coolEscalated ? `${mode} (auto-cool)` : mode,
        reason: verified === null ? `${reason} (unverified: device read failed)` : reason,
      }]).catch(() => {});
      // Update last* (the "I believe the device is in mode X" memory) ONLY when
      // confirmed. On a null read of an ON command, leaving last* stale makes the
      // next cycle's re-assert see modeChanged and RE-FIRE — so a silently-failed
      // ON can't strand Nursery's room hot while the agent thinks it's cooling.
      // (board Opus+GLM 2026-06-21). OFF on a null read is safe to record (the
      // off-guard re-checks the physical device every cycle anyway).
      if (kind === 'off') {
        rs.lastMode = 'off';
      } else if (verified === true) {
        rs.lastMode = mode;
        rs.lastSetpoint = setpoint;
        rs.lastFan = rung; // INTERNAL ladder value, not the abstract fan
      } // else: ON unverified → leave last* stale so re-assert retries next cycle.
      return true;
    } catch (e) {
      addLog(`${roomId}: setAta ${kind} failed — ${e instanceof Error ? e.message : 'unknown'}`);
      return false;
    }
  };

  // ── SAFETY INVARIANTS (out-of-bounds → alert; actuate toward safety) ──
  // The safety path forces the split ON toward the target in the resolved mode
  // (default 'cool' since 2026-07-11; a manual 'dry' pin is honoured).
  const safetyAction = checkSafetyInvariants(roomId, temp, rs.consecutiveNullReadings, config, season);
  if (safetyAction) {
    await sendAlert(state, safetyAction.severity, safetyAction.message, roomId);
    if (safetyAction.mode === 'off') {
      await actuate('off', rs.controlState, safetyAction.message);
      rs.controlState = 'SATISFIED';
    } else {
      await actuate('on', rs.controlState, safetyAction.message);
      rs.controlState = 'COOLING';
    }
    addLog(`${roomId}: SAFETY ${safetyAction.mode.toUpperCase()} — ${safetyAction.message}`);
    return;
  }

  // ── SENSOR FAULT (probe dark ≥ threshold) ──
  if (rs.consecutiveNullReadings >= SENSOR_FAULT_THRESHOLD) {
    if (rs.consecutiveNullReadings >= SENSOR_FAULT_THRESHOLD) {
      await sendAlert(state, 'critical',
        `Campomarino/${roomId}: split non risponde da ${rs.consecutiveNullReadings * 5} min`, roomId);
    }
    // No temp → can't decide a target-based action. For a critical room, drive
    // defensive cool toward target (best effort); else leave as-is.
    if (config.critical && rs.controlState !== 'COOLING') {
      if (await actuate('on', rs.controlState, 'sensor_fault_defensive')) rs.controlState = 'COOLING';
    }
    addLog(`${roomId}: SENSOR_FAULT (${rs.consecutiveNullReadings} nulls)`);
    return;
  }

  if (temp === null || !Number.isFinite(temp)) return;

  // ── MANUAL-OFF HOLD ──
  // If the user toggled this split OFF in the UI, the agent must not auto-turn
  // it back on for 30 min — the brain doesn't contradict an explicit human OFF.
  // (Safety invariants above already ran and DO override this, so a baby room
  // above safety_max still gets rescued.) Reading-only + bookkeeping still run.
  const manualHold = typeof rs.manualOffUntil === 'number' && Date.now() < rs.manualOffUntil;
  if (manualHold) {
    const minsLeft = Math.ceil((rs.manualOffUntil! - Date.now()) / 60000);
    addLog(`${roomId}: manual-off hold (${minsLeft} min left) — auto-on suppressed`);
    return;
  }

  // ── OFF-GUARD — never trust controlState, look at the physical device ──
  // The agent can believe a split is OFF (controlState=SATISFIED, lastMode=off)
  // while the device is still physically ON — command latency, a stale state, or
  // a manual re-on. If the room does NOT need cooling (temp below the ON
  // threshold offThreshold = target+0.3 for Campomarino) but the device is
  // physically ON, force it OFF every cycle until the hardware confirms off. This
  // is what makes "off" mean off. Above offThreshold the room genuinely wants
  // cooling, so the hysteresis below keeps it on — the guard must not fight that.
  // (Fabio 2026-06-21 — Milano has the same guard; Campomarino lacked it.)
  //
  // CRITICAL (Fabio 2026-06-30): `dev` comes from ListDevices, which reports
  // STALE/incoherent power for these splits (same defect as SetFanSpeed=null —
  // only Device/Get is authoritative). Trusting dev.power here left a split
  // stranded ON at 26.7°C while the agent thought it was OFF. So when the agent
  // is NOT cooling and the room is below offThreshold, confirm the REAL power with
  // a Device/Get before deciding; fall back to dev.power only if that read fails.
  if (rs.controlState !== 'COOLING' && temp <= config.offThreshold) {
    let physicallyOn = dev?.power === true; // ListDevices prior (may be stale)
    try {
      const fresh = await getDevice(deviceId, buildingId ?? 0); // authoritative
      if (fresh.power !== null) physicallyOn = fresh.power === true;
    } catch { /* read failed → keep the dev.power prior */ }
    if (physicallyOn) {
      const ok = await actuate('off', rs.controlState, `off-guard: device confirmed ON but temp=${temp}°C <= ${config.offThreshold}°C (acceptable) and not cooling`);
      rs.controlState = 'SATISFIED';
      if (ok) rs.lastTransitionCycle = state.cycleCount;
      addLog(`${roomId}: OFF-GUARD re-sent off (device was ON at ${temp}°C, target ${config.target}°C)`);
      return;
    }
  }

  // ── HYSTERESIS STATE MACHINE (cool) — keep temp near target, NEVER below ──
  // Fabio 2026-06-21: the goal is to hold the room AS CLOSE TO target as possible
  // and never colder. The whole dead-band sits ABOVE target (Campomarino = 0.3°C):
  //   • OFF as soon as temp <= target          (never cool below the setpoint)
  //   • target..target+0.3 is acceptable        (don't re-cool for a third of a degree)
  //   • turn back ON only when temp > target+0.3 (i.e. 27.3 with target 27)
  // No rate/dwell/mode caps on this path (would strand Nursery's room hot).
  let newState: ControlState = rs.controlState;

  // SATISFIED → COOLING: room climbed ABOVE target + 0.5°C (strict — +0.5 is OK).
  if (rs.controlState === 'SATISFIED' && temp > config.offThreshold) {
    newState = 'COOLING';
  }
  // COOLING → SATISFIED (OFF): room reached the target. Spegni a target, mai sotto.
  if (rs.controlState === 'COOLING' && temp <= config.target) {
    newState = 'SATISFIED';
  }
  // Recover from a non-cool state (HEATING/SENSOR_FAULT/DISABLED): same rule —
  // OFF at/below target+0.5 (acceptable), ON only strictly above target+0.5.
  if (rs.controlState !== 'SATISFIED' && rs.controlState !== 'COOLING') {
    newState = temp > config.offThreshold ? 'COOLING' : 'SATISFIED';
  }

  if (newState !== rs.controlState) {
    const prevState = rs.controlState;
    if (newState === 'SATISFIED') {
      if (await actuate('off', prevState, `temp=${temp}°C <= target ${config.target}°C`)) {
        rs.controlState = 'SATISFIED';
        rs.lastTransitionCycle = state.cycleCount;
        // Reaching target consumes a manual mode/fan pin: the override lasts one
        // cooling episode, not forever — next episode restarts from the auto
        // default (dry-silent / cool-min). The manual-OFF hold (manualOffUntil) is
        // a different gesture ("user wants it off") and is NOT cleared here.
        // (Fabio 2026-06-30.)
        if (rs.manualMode !== null || rs.manualFan !== null) {
          rs.manualMode = null;
          rs.manualFan = null;
          addLog(`${roomId}: manual override consumed at target → back to auto`);
        }
        addLog(`${roomId}: ${prevState} → OFF at ${temp}°C (target ${config.target}°C)`);
      }
    } else {
      if (await actuate('on', prevState, `temp=${temp}°C >= offThreshold ${config.offThreshold}°C`)) {
        rs.controlState = 'COOLING';
        rs.lastTransitionCycle = state.cycleCount;
        addLog(`${roomId}: ${prevState} → COOLING(${onMode}) at ${temp}°C`);
      }
    }
    return;
  }

  // ── Re-assert within active state (setpoint/mode/fan drift correction) ──
  if (rs.controlState === 'COOLING' && temp !== null) {
    const setpoint = computeSetpoint(roomId, temp, config, season);
    // Compare in INTERNAL ladder space with the SAME dry+silent coercion actuate
    // applies, or pinning silent in dry (rung 0 → sent as 1) would read as a
    // permanent mismatch and re-fire setAta every cycle.
    let rung = fanRung(onMode);
    if (onMode === 'dry' && rung === SILENT_FAN) rung = 1;
    const setpointChanged = rs.lastSetpoint === null || Math.abs(setpoint - rs.lastSetpoint) >= 0.5;
    const fanChanged = rs.lastFan === null || rs.lastFan !== rung;
    const modeChanged = rs.lastMode !== onMode;
    if (setpointChanged || fanChanged || modeChanged) {
      if (await actuate('on', rs.controlState, 'reassert')) {
        addLog(`${roomId}: re-assert ${onMode} sp=${setpoint} fan=${rung} at ${temp}°C`);
      }
    }
  }
}
