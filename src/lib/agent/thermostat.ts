import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { getHomeStatus, setRoomState } from '@/lib/netatmo/client';
import { loadNetatmoContext } from '@/lib/netatmo/context';
import { saveAgentState, type AgentState } from '@/lib/agent/state';
import type { RoomConfig } from '@/lib/agent/safety';

// ─── Thermostat valve management ───────────────────────────────────────────────

// Cron cadence is 2 min. A 5-min cooldown used to block 3 out of every 5
// cycles when the thermostat genuinely needed a small (<2°C) boost — the
// urgent-gap bypass only fires on ≥2°C. 90s lets every cron cycle through
// while still deduplicating within-cycle double writes from overlapping
// invocations.
export const THERMOSTAT_COOLDOWN_MS = 90 * 1000;
// Sentinel valve fallback (Smarther 2 not a ThermRelay):
// - 60s cooldown: Netatmo rate-limit hedge, Vercel cron runs every 2m anyway.
// - 28°C setpoint: above bagno1's realistic max (23°C) so valve always opens
//   while the heat cycle is on; short endtime so a stuck sentinel self-heals.
// - 10min endtime: covers 5 cycles; sentinel re-arms if still needed.
export const SENTINEL_COOLDOWN_MS = 60 * 1000;
export const SENTINEL_TEMP = 28;
export const SENTINEL_ENDTIME_SEC = 10 * 60;
export const SENTINEL_ROOM = 'bagno1'; // must be a Netatmo ThermRelay-capable room

/**
 * Thermostat master invariant (Fabio's house rule):
 *   The central Smarther 2 thermostat controls whether the boiler calls for
 *   heat. Any satellite (Sabiana fancoil, Netatmo bathroom valve) that opens
 *   while the thermostat is NOT calling receives cold/tepid water, so:
 *     (a) the fancoil blows cold air on Nursery, and
 *     (b) the closed bathroom valve condenses humidity on its cold surface.
 *
 *   Invariant: while any satellite is heating, the thermostat's effective
 *   setpoint MUST exceed the satellite's real room temperature by a margin
 *   large enough to guarantee the boiler fires. Using only a fixed +2 or +3°C
 *   above the thermostat's own temperature is not enough — a warm living room
 *   with a cold bedroom would leave the boiler silent.
 *
 *   We now compute the override as:
 *     needed = max(
 *       thermTemp + baseBoost,            // thermostat itself feels cold enough
 *       maxSatelliteTemp + satelliteMargin // highest warm satellite still calls boiler
 *     )
 *   clamped to [thermSetpointUser, 35].
 */
export const THERM_BASE_BOOST = 2.0;
export const THERM_BASE_BOOST_LEONE = 3.0;
export const THERM_SATELLITE_MARGIN = 2.5; // °C above the warmest satellite room

/**
 * Sentinel valve fallback: the central Smarther 2 BTicino rejects
 * /api/setroomthermpoint ("device is not a ThermRelay") because writes on that
 * unit require Works with Legrand OAuth, not Netatmo Connect. Until that
 * migration lands, we pilot the boiler by raising `SENTINEL_ROOM`'s Netatmo
 * valve (which IS a ThermRelay) to a temperature high enough to guarantee
 * heat-call. Endtime is short so a stranded sentinel self-heals within 10min.
 *
 * Returns true if a Netatmo call was made (caller logs the outcome).
 */
async function activateSentinel(
  state: AgentState,
  accessToken: string,
  homeId: string,
  sentinelRoomId: string,
  now: number,
): Promise<{ sent: boolean; reason: string }> {
  if (now - state.lastSentinelCommandTime < SENTINEL_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  const endtime = Math.floor(now / 1000) + SENTINEL_ENDTIME_SEC;
  await setRoomState(accessToken, homeId, sentinelRoomId, 'manual', SENTINEL_TEMP, endtime);
  state.sentinelActive = true;
  state.lastSentinelCommandTime = now;
  return { sent: true, reason: 'activated' };
}

async function deactivateSentinel(
  state: AgentState,
  accessToken: string,
  homeId: string,
  sentinelRoomId: string,
  now: number,
): Promise<{ sent: boolean; reason: string }> {
  if (now - state.lastSentinelCommandTime < SENTINEL_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  await setRoomState(accessToken, homeId, sentinelRoomId, 'home');
  state.sentinelActive = false;
  state.lastSentinelCommandTime = now;
  return { sent: true, reason: 'deactivated' };
}

export async function manageThermostat(
  state: AgentState,
  heatingRoomIds: Set<string>,
  freshReadings: Record<string, { temperature: number; humidity: number }>,
  roomConfigs: Record<string, RoomConfig>,
): Promise<string> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    console.warn('[THERM] skipped: no Netatmo access token (user needs to re-auth)');
    return 'skip:no_netatmo_token';
  }

  let homeId: string;
  let thermostatRoomId: string;
  let sentinelRoomId: string | null = null;
  try {
    const ctx = await loadNetatmoContext();
    if (!ctx.homeId) {
      console.warn('[THERM] skipped: no netatmo_home record in tokens table');
      return 'skip:no_netatmo_home';
    }
    homeId = ctx.homeId;

    thermostatRoomId = ctx.roomMap?.soggiorno || ctx.roomMap?.termostato || '';
    if (!thermostatRoomId) {
      console.warn('[THERM] skipped: no thermostat room id in netatmo_room_map (expected keys: soggiorno or termostato)');
      return 'skip:no_thermostat_room_map';
    }
    sentinelRoomId = ctx.roomMap?.[SENTINEL_ROOM] ?? null;
  } catch (e) {
    console.error('[THERM] Supabase lookup failed:', e instanceof Error ? e.message : e);
    return `skip:supabase_lookup_failed:${e instanceof Error ? e.message : 'unknown'}`;
  }

  let thermSetpoint: number;
  try {
    const home = await getHomeStatus(accessToken, homeId);
    const room = home.rooms?.find(r => String(r.id) === thermostatRoomId);
    if (!room) {
      console.warn(`[THERM] skipped: thermostat room ${thermostatRoomId} not found in Netatmo homestatus`);
      return 'skip:thermostat_room_not_in_homestatus';
    }
    const rawThermSp = room.therm_setpoint_temperature;
    if (rawThermSp == null) {
      console.warn('[THERM] skipped: thermostat setpoint is null');
      return 'skip:setpoint_null';
    }
    thermSetpoint = rawThermSp;
  } catch (e) {
    console.error('[THERM] Netatmo homestatus failed:', e instanceof Error ? e.message : e);
    return `skip:homestatus_failed:${e instanceof Error ? e.message : 'unknown'}`;
  }

  // Use the cucina Sonoff reading as the thermostat's reference temperature.
  // Rationale: the Smarther 2 internal sensor is in the large open living room
  // where air stratifies and probe placement biases the reading. The cucina
  // Sonoff (next to the living room, no heat source mounted on it) tracks
  // actual apartment ambient far better in practice. Fall back to the BTicino
  // internal sensor only if the Sonoff is missing.
  const cucinaReading = freshReadings['cucina'];
  const thermTemp = cucinaReading?.temperature ?? null;
  if (thermTemp == null) {
    // Cucina Sonoff absent — without a trusted reference we cannot safely
    // compute the boost. Skip this cycle, agent will retry.
    console.warn('[THERM] No cucina reading available, skipping thermostat management this cycle');
    return 'skip:no_cucina_reading';
  }

  const now = Date.now();
  const cooldownOk = now - state.lastThermostatCommandTime > THERMOSTAT_COOLDOWN_MS;

  if (heatingRoomIds.size > 0) {
    // Base boost relative to the reference (cucina) temperature.
    const baseBoost = heatingRoomIds.has('leone') ? THERM_BASE_BOOST_LEONE : THERM_BASE_BOOST;
    const boostedByThermTemp = thermTemp + baseBoost;

    // Satellite-aware boost: find the warmest heating satellite and make sure
    // the thermostat setpoint clears its temperature by SATELLITE_MARGIN. This
    // protects the invariant even when the reference room is already warm.
    let warmestSatelliteTemp = -Infinity;
    for (const roomId of heatingRoomIds) {
      // Exclude both the BTicino room (soggiorno) and the reference (cucina)
      // so the algorithm focuses on the rooms that actually need heat.
      if (roomId === 'soggiorno' || roomId === 'cucina') continue;
      const reading = freshReadings[roomId];
      if (reading?.temperature != null) {
        warmestSatelliteTemp = Math.max(warmestSatelliteTemp, reading.temperature);
      }
    }
    const boostedBySatellite = Number.isFinite(warmestSatelliteTemp)
      ? warmestSatelliteTemp + THERM_SATELLITE_MARGIN
      : -Infinity;

    const neededRaw = Math.max(boostedByThermTemp, boostedBySatellite);
    const neededSetpoint = Math.round(Math.min(35, neededRaw) * 2) / 2;
    const setpointGap = neededSetpoint - thermSetpoint;

    // Urgency bypass: if the current thermostat setpoint is ≥2°C below the
    // needed one, satellites are calling for heat while the boiler is still
    // idle. Waiting out the 5-min cooldown means fancoils blow cold air
    // (dangerous for Nursery) and valves condense humidity. Bypass cooldown.
    const urgent = setpointGap >= 2;
    const shouldCommand = Math.abs(setpointGap) >= 0.5 && (cooldownOk || urgent);

    if (shouldCommand) {
      // Persist `originalThermostatSetpoint` BEFORE hitting Netatmo so a
      // crash between the API call and end-of-cycle save doesn't strand the
      // thermostat in override mode (we'd lose the value to restore to).
      // The Netatmo endtime also self-heals within 2h, this closes the gap.
      if (state.originalThermostatSetpoint === null) {
        state.originalThermostatSetpoint = thermSetpoint;
        try {
          await saveAgentState(state);
        } catch (e) {
          console.error('[THERM] state pre-save failed (proceeding):', e instanceof Error ? e.message : e);
        }
      }

      try {
        const twoHoursFromNow = Math.floor(now / 1000) + 7200;
        await setRoomState(accessToken, homeId, thermostatRoomId, 'manual', neededSetpoint, twoHoursFromNow);
        state.lastThermostatCommandTime = now;
        const warmRoom = Number.isFinite(warmestSatelliteTemp) ? warmestSatelliteTemp.toFixed(1) : 'n/a';
        const urgentTag = urgent && !cooldownOk ? ' URGENT' : '';
        console.log(`[THERM] Override${urgentTag} ${thermSetpoint}→${neededSetpoint}°C (ref=cucina ${thermTemp.toFixed(1)}, warmestSatellite=${warmRoom}, ${heatingRoomIds.size} rooms heating, leone=${heatingRoomIds.has('leone')})`);
        void roomConfigs;
        return `override${urgent && !cooldownOk ? ':urgent' : ''}:${thermSetpoint}→${neededSetpoint} ref=${thermTemp.toFixed(1)}`;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'unknown';
        console.error('[THERM] Failed:', e);
        // Smarther 2 rejects setroomthermpoint. Fall back to the sentinel
        // valve so the boiler still fires for the heating satellites.
        //
        // Originally this path was skipped when `bagno1`/`bagno2` were in
        // heatingRoomIds — the assumption was "bathroom cold → valve open
        // → boiler already lit". That was wrong: a bathroom appears in
        // heatingRoomIds because its Sonoff reads below target, but the
        // Netatmo valve only opens if the USER'S schedule on Home+Control
        // currently allows it. With the schedule off, the valve stays shut
        // and the boiler stays silent even while the room is cold. Live
        // prod proved it today (bagno1 at 18°C, log showed
        // "sentinel:unneeded:bathroom_heating", boiler silent).
        //
        // Always activate the sentinel on Smarther failure — the 60s
        // cooldown + 10min endtime keep side-effects bounded if the
        // bathroom happens to already be heating.
        if (sentinelRoomId) {
          try {
            const sent = await activateSentinel(state, accessToken, homeId, sentinelRoomId, now);
            if (sent.sent) {
              console.log(`[THERM] Sentinel activated on ${SENTINEL_ROOM}@${SENTINEL_TEMP}°C (smarther rejected, ${heatingRoomIds.size} rooms heating)`);
              return `sentinel:active:${SENTINEL_ROOM}@${SENTINEL_TEMP} reason=smarther_${errMsg.slice(0, 40)}`;
            }
            return `sentinel:skip:${sent.reason} smarther=${errMsg.slice(0, 40)}`;
          } catch (se) {
            console.error('[THERM] Sentinel activation failed:', se);
            return `sentinel:failed:${se instanceof Error ? se.message : 'unknown'} smarther=${errMsg.slice(0, 40)}`;
          }
        }
        return `override:api_failed:${errMsg}`;
      }
    }
    void roomConfigs;
    return `noop:gap=${setpointGap.toFixed(1)} cooldownOk=${cooldownOk} urgent=${urgent} setpoint=${thermSetpoint} needed=${neededSetpoint} ref=${thermTemp.toFixed(1)} warmest=${Number.isFinite(warmestSatelliteTemp) ? warmestSatelliteTemp.toFixed(1) : 'n/a'}`;
  } else if (heatingRoomIds.size === 0 && state.originalThermostatSetpoint !== null && cooldownOk) {
    // RESTORE path. Use mode='home' so Netatmo reverts to the user's schedule
    // instead of staying in manual forever (endtime=0 would lock the setpoint
    // permanently and silently destroy the thermostat program). This is the
    // same effect as tapping "schedule" in the BTicino app.
    try {
      await setRoomState(accessToken, homeId, thermostatRoomId, 'home');
      console.log(`[THERM] Restored to schedule (was overriding from ${state.originalThermostatSetpoint}°C)`);
      state.lastThermostatCommandTime = now;
      state.originalThermostatSetpoint = null;
      return 'restored_to_schedule';
    } catch (e) {
      console.error('[THERM] Restore failed:', e instanceof Error ? e.message : e);
      // Leave originalThermostatSetpoint set so next cycle retries the restore.
      return `restore_failed:${e instanceof Error ? e.message : 'unknown'}`;
    }
  }
  // Sentinel deactivation: even if the Smarther restore path above didn't
  // trigger (originalThermostatSetpoint null because the Smarther override
  // never succeeded), a sentinel that was activated during the last heating
  // burst MUST be reset to schedule. Otherwise bagno1 stays stuck at 28°C
  // forever (endtime self-heals in 10min, but re-arming at every cycle while
  // heating keeps it pinned).
  if (heatingRoomIds.size === 0 && state.sentinelActive && sentinelRoomId) {
    try {
      const dec = await deactivateSentinel(state, accessToken, homeId, sentinelRoomId, now);
      if (dec.sent) {
        console.log(`[THERM] Sentinel deactivated on ${SENTINEL_ROOM} (no rooms heating)`);
        return `sentinel:restored:${SENTINEL_ROOM}`;
      }
      return `sentinel:restore_skip:${dec.reason}`;
    } catch (e) {
      console.error('[THERM] Sentinel restore failed:', e instanceof Error ? e.message : e);
      return `sentinel:restore_failed:${e instanceof Error ? e.message : 'unknown'}`;
    }
  }
  return `idle:heating=${heatingRoomIds.size} originalSp=${state.originalThermostatSetpoint} cooldownOk=${cooldownOk} sentinel=${state.sentinelActive}`;
}
