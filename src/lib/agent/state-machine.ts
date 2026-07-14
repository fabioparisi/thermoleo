/**
 * ThermoLeo per-room state-machine processing.
 *
 * Extracted from src/app/api/agent/cycle/route.ts (Step 3c).
 * Contains all constants, helpers, and the main processRoom function
 * that drives the SAFETY → SENSOR_FAULT → STATE MACHINE → adjust loop
 * for each Sabiana fancoil room.
 */

import { getValidToken } from '@/lib/sabiana/token-manager';
import { sendCommand } from '@/lib/sabiana/client';
import type { SabianaCommand } from '@/lib/sabiana/types';
import { getRoomState, type AgentState, type ControlState } from '@/lib/agent/state';
import { SENSOR_FAULT_THRESHOLD, checkSafetyInvariants, type RoomConfig } from '@/lib/agent/safety';
import { supaInsert } from '@/lib/supabase/rest';

/** Season values the per-room control loop knows about. 'off' is handled
 *  upstream in /api/agent/cycle and never reaches processRoom. */
export type ActiveSeason = 'heat' | 'cool';

// ─── Constants ─────────────────────────────────────────────────────────────────

// Timing constraints (in cycles, each cycle ≈ 10 min — pg_cron schedule */10).
// Cycle interval was 2min until 2026-05-25; lowered to 10min to stay safely
// under Vercel free-plan invocation rate. Constants below converted in-place
// to keep approximate wall-clock semantics intact.
export const MIN_ON_CYCLES = 1;           // 10 min minimum active state before OFF (was 4 cycles × 2min = 8min)
export const MIN_OFF_CYCLES = 1;          // 10 min minimum OFF before ON (was 8 min)
export const MIN_OFF_CYCLES_LEONE = 1;    // 10 min for leone, same as others (was 6 min)
const MAX_MODE_CHANGES_PER_HOUR = 4;
// Rate limits don't depend on cycle frequency — they're per-hour caps.
// Cool needs more headroom than heat because:
//   - fan ladder has 4 reactive levels (off + 1/2/3) vs heat's 3 levels;
//   - chiller water temp swings as the condominio cycles, triggering more
//     re-adjustments per hour;
//   - external manual pushes (UI, direct PATCH) collide with agent commands,
//     and a too-low limit deadlocks the agent into never re-sending when the
//     device drifts away from lastFan/lastSetpoint.
const MAX_COMMANDS_PER_HOUR_HEAT = 8;
const MAX_COMMANDS_PER_HOUR_COOL = 20;
const SENSOR_ALERT_THRESHOLD = 3;  // 3 cycles × 10min = 30 min = critical alert (was 15 cycles × 2min)
export const HISTORY_WINDOW = 6;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export const HYSTERESIS = 0.5; // ±0.5°C around target — dead-band to minimize hunting

// Rooms permanently excluded from agent actuation regardless of season.
// Was {'camera'} (winter: matrimoniale fancoil kept manual). Cleared 2026-05-25
// per user request — camera handles cool same as the other Sabianas now.
export const DISABLED_ROOMS = new Set<string>([]);

// ─── Pure helpers ──────────────────────────────────────────────────────────────

export function calcTrend(history: { temp: number }[]): number {
  if (history.length < 3) return 0;
  const recent = history.slice(-3);
  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((s, h) => s + h.temp, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (recent[i].temp - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Magnitude of the control error. In heat mode `error > 0` means the room is
 * too cold; in cool mode `error > 0` means the room is too hot. The same
 * magnitude scale drives fan + setpoint adjustments for both seasons.
 */
export function errorMagnitude(season: ActiveSeason, target: number, temp: number): number {
  return season === 'cool' ? temp - target : target - temp;
}

export function computeFanSpeed(roomId: string, temp: number, config: RoomConfig, season: ActiveSeason): number {
  const error = errorMagnitude(season, config.target, temp);

  // Cool fan ladder. Sabiana cloud API only honours fan 1-3 (SLu1/SCu2/SHu3
  // motor presets); higher values get silently ignored — verified
  // empirically 2026-05-25 (fan=7 and fan=10 both collapsed to level 1 raw).
  //
  // CAMERA (matrimoniale, sleep room) — quietest ladder, shifted by one
  // step so noise stays at fan 1 even with 2°C above target:
  //   error ≤ 2°C → 1 (silent)
  //   2 < e ≤ 3  → 2
  //   e > 3      → 3
  //
  // Standard ladder (leone, studio, cucina, soggiorno):
  //   error ≤ 1°C → 1 (SLu1, silent)
  //   1 < e ≤ 2  → 2 (SCu2)
  //   e > 2      → 3 (SHu3, hardware max)
  //
  // (Soggiorno had a forced fan=3-always override briefly on 2026-05-26
  // to compensate for tepid chiller water; reverted same day once we
  // learned the actual block was T-MB2 cooling-protection thresholds
  // and an installer deadband — fan max wasn't the real lever.)
  //
  // Below ≤ 0 the state machine has already transitioned to SATISFIED
  // and turned the fancoil off — this helper is only called while
  // controlState === 'COOLING' (error > 0).
  if (season === 'cool') {
    // Phase 3b: the quiet "silent" ladder (was `roomId === 'camera'`) now keys
    // off the DB-sourced config.fanProfile.
    if (config.fanProfile === 'silent') {
      if (error > 3) return 3;
      if (error > 2) return 2;
      return 1;
    }
    if (error > 2) return 3;
    if (error > 1) return 2;
    return 1;
  }

  // Heat ladder unchanged from pre-cool-feature behaviour.
  if (roomId === 'leone') {
    if (error > 1.0) return 2;
    return 1;
  }
  if (error > 1.5) return 3;
  if (error > 0.7) return 2;
  return 1;
}

export function computeSetpoint(roomId: string, temp: number, config: RoomConfig, season: ActiveSeason): number {
  // MELCloud splits take the REAL room target (they self-regulate on their own
  // probe; there's no T1-bias workaround like Sabiana). Branch FIRST and ONLY on
  // an explicit 'melcloud' — every other apiSource (incl. a missing/typo'd one,
  // which the loader defaults to 'sabiana') falls through to the Sabiana logic
  // below UNCHANGED. Getting this polarity wrong would silently invert Milano's
  // setpoint floor, so 'melcloud' is the special case, Sabiana is the default.
  if (config.apiSource === 'melcloud') {
    // Cool: command the UI target (clamped to the device's safe range by setAta's
    // per-mode clamp downstream). Heat: same — the split heats to the target.
    const t = config.target;
    return Number.isFinite(t) ? Math.round(t * 2) / 2 : config.safetyMin;
  }

  // In cool mode we hard-floor the Sabiana setpoint to safety.min. Why:
  //
  // The fancoil arbitrates the internal water valve on its OWN T1 probe (return
  // air, ~5°C colder than ambient because it sits in the chilled mandata). When
  // we computed sp = target - 2 = 24.5°C on a 26.5 target, the unit saw T1=23.3
  // < sp=24.5 → "stanza già fredda" → valve closed, no cold water flow.
  // Meanwhile Soggiorno (T1≈Sonoff because the unit sits differently) called
  // water with the same setpoint. Same building loop, opposite behaviour —
  // matched what the user observed ("Nursery no acqua, Soggiorno sì").
  //
  // Bypass: command sp = safety.min so the fancoil ALWAYS sees T1 >> sp and
  // calls water. The agent throttles via mode=off/on (hysteresis on Sonoff
  // truth in the state machine) — fine-grained PID on the Sabiana side is
  // abandoned. Setpoint shown on the CB-Touch panel will look low (16-18°C)
  // but it represents "give me cold water now", not "I want the room at 16°C".
  if (season === 'cool') {
    // Phase 3b: read the cool floor from the DB-sourced config bound. Fallback
    // 16 preserved for a malformed/non-finite bound (matches the former
    // `safety ? safety.min : 16`).
    return Number.isFinite(config.safetyMin) ? config.safetyMin : 16;
  }

  // Heat mode: original logic preserved (T1 bias in heat is the opposite
  // direction — slightly warm-biased when the unit blows hot — so the
  // target+0.8*error push works as designed).
  const error = errorMagnitude(season, config.target, temp);
  let setpoint: number;
  if (error > 1.5) {
    setpoint = config.target + 2.0;
  } else if (error > 0.5) {
    setpoint = config.target + error * 0.8;
  } else {
    setpoint = config.target;
  }

  // Phase 3b: clamp to the DB-sourced config bounds (finite-guarded; preserves
  // the former `if (safety)` "no bounds → no clamp" semantics).
  if (Number.isFinite(config.safetyMin) && Number.isFinite(config.safetyMax)) {
    setpoint = Math.max(config.safetyMin, Math.min(config.safetyMax, setpoint));
  }

  if (setpoint < temp) {
    setpoint = temp;
  }

  return Math.round(setpoint * 2) / 2;
}

export function canChangeMode(state: AgentState, roomId: string): boolean {
  const rs = getRoomState(state, roomId);
  const oneHourAgo = Date.now() - 3600_000;
  rs.modeChangeTimestamps = rs.modeChangeTimestamps.filter(t => t > oneHourAgo);
  return rs.modeChangeTimestamps.length < MAX_MODE_CHANGES_PER_HOUR;
}

export function canSendCommand(state: AgentState, roomId: string, season: ActiveSeason): boolean {
  const rs = getRoomState(state, roomId);
  const oneHourAgo = Date.now() - 3600_000;
  rs.commandTimestamps = rs.commandTimestamps.filter(t => t > oneHourAgo);
  const cap = season === 'cool' ? MAX_COMMANDS_PER_HOUR_COOL : MAX_COMMANDS_PER_HOUR_HEAT;
  return rs.commandTimestamps.length < cap;
}

// ─── Effect helpers ────────────────────────────────────────────────────────────

export async function sendAlert(state: AgentState, severity: string, message: string, roomId: string) {
  const key = `${roomId}_${severity}`;
  const now = Date.now();
  if (state.alertCooldowns[key] && now - state.alertCooldowns[key] < ALERT_COOLDOWN_MS) return;
  state.alertCooldowns[key] = now;

  console.log(`[ALERT ${severity}] ${roomId}: ${message}`);

  if (severity === 'critical' || severity === 'warning') {
    const proxyUrl = process.env.IMESSAGE_PROXY_URL || 'http://localhost:9100';
    const recipient = process.env.IMESSAGE_RECIPIENT || 'fabioparisi@me.com';
    try {
      await fetch(`${proxyUrl}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipient, message: `🌡️ ThermoLeo [${severity}]: ${message}` }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* proxy may not be reachable from Vercel */ }
  }

  supaInsert('alerts', [{ room_id: roomId, severity, message, created_at: new Date().toISOString() }]).catch(() => {});
}

async function sendSabianaCmd(
  token: string,
  deviceId: string,
  mode: 'heat' | 'cool' | 'off',
  setpoint: number,
  fan: number,
): Promise<boolean> {
  const cmd: SabianaCommand = {
    temperature: setpoint,
    mode,
    fan,
    swing: 1,
    preset: 0,
  };
  return sendCommand(token, deviceId, cmd);
}

// ─── ProcessRoom context ───────────────────────────────────────────────────────

/** Shape of each device entry as built in route.ts (SabianaDeviceState with nullable temp). */
export interface ProcessRoomDevice {
  deviceId: string;
  temperature: number | null;
  setpoint: number;
  fanSpeed: number;
  mode: string;
  /** True when the fan is actually moving air (byte[7] nibble 0-3). This is
   *  the reliable "is the unit running" signal — `mode` is the sticky thermal
   *  mode (byte[5]) and stays heat/cool even when off. */
  fanRunning: boolean;
  connectionUp: boolean;
}

export interface ProcessRoomContext {
  roomId: string;
  state: AgentState;
  device: ProcessRoomDevice;
  config: RoomConfig;
  heatingRoomIds: Set<string>;
  /** Mutable ref for lazy-init Sabiana token — shared across all rooms in a cycle. */
  tokenHolder: { token: string | null };
  addLog: (msg: string) => void;
  /** Active season for this cycle. 'heat' = winter (default), 'cool' = summer.
   *  When 'off' is the building-loop state, the caller skips processRoom entirely. */
  season: ActiveSeason;
}

// ─── Global-OFF shutdown (season='off') ─────────────────────────────────────────

/** Per-room cap on shutdown commands per hour while season='off'. Generous —
 *  shutting a fancoil down is the safe direction and we want it to win — but
 *  still bounded so a flapping device (or a cloud that never reports 'off'
 *  back) can't spam the Sabiana API forever. 6/h = at most one attempt per
 *  10-min cycle. */
const MAX_OFF_COMMANDS_PER_HOUR = 6;

export interface ShutdownDevice {
  deviceId: string;
  mode: string;
  /** True when the fan is moving air (byte[7] nibble 0-3) — the reliable
   *  "still running" signal. `mode` (byte[5]) is sticky and stays heat/cool
   *  even when off, so it can't tell us the unit is already off. */
  fanRunning: boolean;
  setpoint: number;
  fanSpeed: number;
  connectionUp: boolean;
}

/**
 * Idempotently force one fancoil to mode='off' while season='off'.
 *
 * This is the hardware half of the global-OFF switch. The POST /api/settings
 * handler already broadcasts 'off' to all 5 fancoils the instant the user
 * taps Off; this runs every agent cycle afterwards and re-asserts 'off' on
 * any unit that is NOT already off — covering a failed initial command, a
 * manual CB-Touch panel press, or a unit that powered back up. Setpoint is
 * preserved so re-arming heat/cool later keeps the user's number.
 *
 * Returns the action taken so the caller can log it:
 *   'already_off'  — device already off, no command sent
 *   'off_sent'     — turned off this cycle
 *   'rate_limited' — needs off but hit the per-hour cap (logged, retried next cycle)
 *   'skipped'      — device offline / no temp etc.
 *   'failed:<msg>' — Sabiana command threw
 */
export async function shutdownRoomOff(
  roomId: string,
  device: ShutdownDevice,
  state: AgentState,
  tokenHolder: { token: string | null },
): Promise<'already_off' | 'off_sent' | 'rate_limited' | 'skipped' | string> {
  const rs = getRoomState(state, roomId);

  // Mirror the device's real mode into our memory (same resync discipline as
  // processRoom) so the "already off?" check trusts the hardware, not stale
  // optimistic state.
  if (device.connectionUp && typeof device.mode === 'string') {
    rs.lastMode = device.mode;
  }

  if (!device.deviceId || !device.connectionUp) return 'skipped';
  // Already off = the fan is not moving air. We do NOT test `device.mode`:
  // byte[5] stays heat/cool even when the unit is off, so mode==='off' would
  // almost never be true and we'd re-send OFF every single cycle.
  if (!device.fanRunning) {
    rs.controlState = 'SATISFIED';
    return 'already_off';
  }

  // Rate-limit guard using the shared command-timestamp ledger.
  const oneHourAgo = Date.now() - 3600_000;
  rs.commandTimestamps = rs.commandTimestamps.filter(t => t > oneHourAgo);
  if (rs.commandTimestamps.length >= MAX_OFF_COMMANDS_PER_HOUR) {
    // Record the intent even though we can't send: the room SHOULD be off.
    // Without this, controlState lingers at HEATING/COOLING and there's no
    // signal that the device-state mismatch is known. (#2)
    rs.controlState = 'SATISFIED';
    return 'rate_limited';
  }

  try {
    if (!tokenHolder.token) tokenHolder.token = await getValidToken();
    // Preserve the device's current setpoint; fan is irrelevant while off but
    // send a sane value (its own, or 1) so the command is well-formed.
    const setpoint = Number.isFinite(device.setpoint) && device.setpoint > 0 ? device.setpoint : 22;
    const fan = Number.isFinite(device.fanSpeed) && device.fanSpeed > 0 ? device.fanSpeed : 1;
    await sendSabianaCmd(tokenHolder.token, device.deviceId, 'off', setpoint, fan);
    rs.lastMode = 'off';
    rs.controlState = 'SATISFIED';
    rs.lastCommandCycle = state.cycleCount;
    rs.commandTimestamps.push(Date.now());
    rs.modeChangeTimestamps.push(Date.now());
    return 'off_sent';
  } catch (e) {
    return `failed:${e instanceof Error ? e.message.slice(0, 40) : 'err'}`;
  }
}

// ─── Main per-room processor ───────────────────────────────────────────────────

/**
 * Process one room through the full SAFETY → SENSOR_FAULT → STATE MACHINE →
 * adjust pipeline.  Mutates state.roomStates[roomId] and heatingRoomIds in place.
 *
 * Returns { correction: boolean } — true when |error| > HYSTERESIS on the
 * normal state-machine path, so the caller can OR it into anyCorrection.
 * Returns false on DISABLED, SAFETY, SENSOR_FAULT, or null-temp paths
 * (matching the original continue semantics).
 */
export async function processRoom(ctx: ProcessRoomContext): Promise<{ correction: boolean }> {
  const { roomId, state, device, config, heatingRoomIds, tokenHolder, addLog, season } = ctx;
  const rs = getRoomState(state, roomId);
  const temp = device.temperature;
  // Convenience: 'cool' rooms need the symmetrical state-machine.
  const isCool = season === 'cool';
  const activeState: ControlState = isCool ? 'COOLING' : 'HEATING';
  const activeMode: 'heat' | 'cool' = isCool ? 'cool' : 'heat';

  // ── DEVICE RESYNC ──
  // Every cycle, before any decision, mirror the device's actual state into
  // rs.lastSetpoint / rs.lastFan / rs.lastMode. The agent never trusts its
  // own optimistic memory of "what I last sent": if a user pressed +/- on
  // the CB-Touch panel, or a manual /api/sabiana/command call landed, or
  // a deploy restarted the world, the device knows the truth.
  //
  // Without this, setpointChanged/fanChanged below compare against a stale
  // optimistic memory and the agent can deadlock — convinced it already
  // sent the right command while the device says otherwise. Verified
  // 2026-05-25 on cucina: agent state said sp=26 fan=3, device said sp=28
  // fan=1 (overwritten by a manual PATCH), and the agent stayed in
  // "(stable)" for cycles instead of re-asserting its computed target.
  //
  // Only resync the *operational* mode/setpoint/fan triple. controlState,
  // history, timestamps, etc. remain agent-internal — the device doesn't
  // know about HEATING/COOLING/SATISFIED, those are our own labels.
  if (device.connectionUp) {
    if (typeof device.mode === 'string') rs.lastMode = device.mode;
    if (typeof device.setpoint === 'number' && Number.isFinite(device.setpoint)) {
      rs.lastSetpoint = device.setpoint;
    }
    if (typeof device.fanSpeed === 'number' && Number.isFinite(device.fanSpeed)) {
      rs.lastFan = device.fanSpeed;
    }
  }

  // Update history + prune timestamps
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

  // ── DISABLED rooms ──
  if (DISABLED_ROOMS.has(roomId)) {
    rs.controlState = 'DISABLED';
    if (device.mode !== 'off') addLog(`${roomId}: DISABLED`);
    return { correction: false };
  }
  // Recover from stale DISABLED state persisted from a previous config when
  // the room WAS in DISABLED_ROOMS (e.g. camera kept manual all winter).
  // Without this reset the room stays DISABLED forever and the agent never
  // commands it. Drop to SATISFIED and let the state machine below decide.
  if (rs.controlState === 'DISABLED') {
    rs.controlState = 'SATISFIED';
    rs.lastTransitionCycle = state.cycleCount;
    addLog(`${roomId}: DISABLED → SATISFIED (re-enabled, no longer in DISABLED_ROOMS)`);
  }

  // ── SAFETY INVARIANTS (bypass all other logic) ──
  const safetyAction = checkSafetyInvariants(roomId, temp, rs.consecutiveNullReadings, config, season);
  if (safetyAction) {
    await sendAlert(state, safetyAction.severity, safetyAction.message, roomId);
    // Only send command for Sabiana rooms (not bagno)
    if (device.deviceId) {
      try {
        if (!tokenHolder.token) tokenHolder.token = await getValidToken();
        await sendSabianaCmd(tokenHolder.token, device.deviceId, safetyAction.mode, safetyAction.setpoint, safetyAction.fan);
        rs.lastMode = safetyAction.mode;
        rs.lastSetpoint = safetyAction.setpoint;
        rs.lastFan = safetyAction.fan;
        rs.lastCommandCycle = state.cycleCount;
        rs.commandTimestamps.push(Date.now());
        addLog(`${roomId}: SAFETY ${safetyAction.mode.toUpperCase()} sp=${safetyAction.setpoint} fan=${safetyAction.fan} — ${safetyAction.message}`);
      } catch (e) {
        addLog(`${roomId}: safety command failed — ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }
    if (safetyAction.mode === 'heat') rs.controlState = 'HEATING';
    else if (safetyAction.mode === 'cool') rs.controlState = 'COOLING';
    else rs.controlState = 'SATISFIED';
    return { correction: false };
  }

  // ── SENSOR FAULT ──
  if (rs.consecutiveNullReadings >= SENSOR_FAULT_THRESHOLD) {
    if (rs.controlState !== 'SENSOR_FAULT') {
      rs.controlState = 'SENSOR_FAULT';
      rs.lastTransitionCycle = state.cycleCount;
      // Nursery: defensive actuation (heat in winter, cool in summer). Others: off.
      let faultMode: 'heat' | 'cool' | 'off';
      let faultSetpoint: number;
      if (config.critical) {
        faultMode = activeMode;
        faultSetpoint = isCool ? config.target - 0.5 : config.target + 0.5;
      } else {
        faultMode = 'off';
        faultSetpoint = config.target;
      }
      const faultFan = 1;
      try {
        if (!tokenHolder.token) tokenHolder.token = await getValidToken();
        await sendSabianaCmd(tokenHolder.token, device.deviceId, faultMode, faultSetpoint, faultFan);
        rs.lastMode = faultMode;
        rs.commandTimestamps.push(Date.now());
        rs.modeChangeTimestamps.push(Date.now());
        addLog(`${roomId}: SENSOR_FAULT → ${faultMode} (${rs.consecutiveNullReadings} nulls)`);
      } catch { /* silent */ }
    }
    if (rs.consecutiveNullReadings >= SENSOR_ALERT_THRESHOLD) {
      await sendAlert(state, 'critical', `Sensore ${roomId} non risponde da ${rs.consecutiveNullReadings * 2} min`, roomId);
    }
    return { correction: false };
  }

  // NaN guard: NaN != null, so a poisoned reading would slip past the null
  // check, make every threshold comparison false, and freeze the room
  // un-actuated (a liveness failure — Nursery could sit unmanaged). Treat a
  // non-finite temp as no reading.
  if (temp === null || !Number.isFinite(temp) || !device.connectionUp) return { correction: false };

  // ── STATE MACHINE TRANSITIONS ──
  const trend = calcTrend(rs.history);
  const cyclesSinceTransition = state.cycleCount - rs.lastTransitionCycle;
  // Magnitude: positive = needs more actuation (cold in heat mode, hot in cool mode).
  const error = errorMagnitude(season, config.target, temp);

  let newState: ControlState = rs.controlState;

  // Recover from SENSOR_FAULT — re-evaluate against the active threshold.
  if (rs.controlState === 'SENSOR_FAULT') {
    if (isCool) {
      // Room hot → COOLING, room at-or-below offThreshold → SATISFIED.
      newState = temp > config.offThreshold ? 'COOLING' : 'SATISFIED';
    } else {
      newState = temp < config.offThreshold ? 'HEATING' : 'SATISFIED';
    }
    addLog(`${roomId}: sensor recovered → ${newState}`);
  }

  if (isCool) {
    // Symmetric hysteresis dead-band (re-enabled 2026-05-26). Goal is to
    // minimize drift from the user-set target across the day, NOT to react
    // to every 0.1°C wiggle. Once the room is at-or-below target we keep
    // it there until it drifts back ABOVE target + HYSTERESIS, then drive
    // back down to target - HYSTERESIS. Wall-clock cost of the dead-band:
    // up to 2*HYSTERESIS=0.4°C of peak-to-peak swing — much less than the
    // overshoot we observed with off-at-target (which produced rapid on/off
    // cycles every 10 min once temp approached target).
    //
    // SATISFIED → COOLING: ambient crossed offThreshold = target + 0.5°C.
    if (rs.controlState === 'SATISFIED' && temp > config.offThreshold) {
      const minOff = config.critical ? MIN_OFF_CYCLES_LEONE : MIN_OFF_CYCLES;
      if (cyclesSinceTransition >= minOff && canChangeMode(state, roomId)) {
        newState = 'COOLING';
      }
    }
    // COOLING → SATISFIED: ambient at-or-below onThreshold = target - 0.5°C.
    // Trend guard (≤ 0.05): require that we are not still cooling rapidly,
    // so the residual cold air doesn't push the room past the lower edge
    // before turn-off settles.
    if (rs.controlState === 'COOLING' && temp <= config.onThreshold) {
      if (cyclesSinceTransition >= MIN_ON_CYCLES && trend <= 0.05 && canChangeMode(state, roomId)) {
        newState = 'SATISFIED';
      }
    }
    // Cross-season recovery: was HEATING but now we're in cool mode.
    if (rs.controlState === 'HEATING') {
      newState = temp > config.offThreshold ? 'COOLING' : 'SATISFIED';
    }
  } else {
    // SATISFIED → HEATING: temp dropped to onThreshold
    if (rs.controlState === 'SATISFIED' && temp <= config.onThreshold) {
      const minOff = config.critical ? MIN_OFF_CYCLES_LEONE : MIN_OFF_CYCLES;
      if (cyclesSinceTransition >= minOff && canChangeMode(state, roomId)) {
        newState = 'HEATING';
      }
    }
    // HEATING → SATISFIED: temp rose to offThreshold
    if (rs.controlState === 'HEATING' && temp >= config.offThreshold) {
      if (cyclesSinceTransition >= MIN_ON_CYCLES && trend >= -0.05 && canChangeMode(state, roomId)) {
        newState = 'SATISFIED';
      }
    }
    // Cross-season recovery: was COOLING but now we're in heat mode.
    if (rs.controlState === 'COOLING') {
      newState = temp <= config.onThreshold ? 'HEATING' : 'SATISFIED';
    }
  }

  // ── Execute state transition ──
  if (newState !== rs.controlState) {
    const prevState = rs.controlState;
    rs.controlState = newState;
    rs.lastTransitionCycle = state.cycleCount;

    if (newState === 'SATISFIED') {
      // Turn OFF
      try {
        if (!tokenHolder.token) tokenHolder.token = await getValidToken();
        await sendSabianaCmd(tokenHolder.token, device.deviceId, 'off', config.target, 1);
        rs.lastMode = 'off';
        rs.lastCommandCycle = state.cycleCount;
        rs.commandTimestamps.push(Date.now());
        rs.modeChangeTimestamps.push(Date.now());
        heatingRoomIds.delete(roomId);
        addLog(`${roomId}: ${prevState} → OFF at ${temp}°C`);
        supaInsert('agent_actions', [{
          room_id: roomId, action_type: 'mode_change',
          old_value: prevState, new_value: 'off',
          reason: isCool
            ? `temp=${temp}°C <= onThreshold=${config.onThreshold}°C`
            : `temp=${temp}°C >= offThreshold=${config.offThreshold}°C`,
        }]).catch(() => {});
      } catch (e) {
        rs.controlState = prevState; // rollback
        addLog(`${roomId}: OFF command failed — ${e instanceof Error ? e.message : 'unknown'}`);
      }
    } else if (newState === activeState) {
      // Turn ON (heat or cool depending on season)
      const fan = computeFanSpeed(roomId, temp, config, season);
      const setpoint = computeSetpoint(roomId, temp, config, season);
      try {
        if (!tokenHolder.token) tokenHolder.token = await getValidToken();
        await sendSabianaCmd(tokenHolder.token, device.deviceId, activeMode, setpoint, fan);
        rs.lastMode = activeMode;
        rs.lastSetpoint = setpoint;
        rs.lastFan = fan;
        rs.lastCommandCycle = state.cycleCount;
        rs.commandTimestamps.push(Date.now());
        rs.modeChangeTimestamps.push(Date.now());
        heatingRoomIds.add(roomId);
        addLog(`${roomId}: ${prevState} → ${activeState} at ${temp}°C (sp=${setpoint} fan=${fan})`);
        supaInsert('agent_actions', [{
          room_id: roomId, action_type: 'mode_change',
          old_value: prevState, new_value: activeMode,
          reason: isCool
            ? `temp=${temp}°C >= offThreshold=${config.offThreshold}°C`
            : `temp=${temp}°C <= onThreshold=${config.onThreshold}°C`,
        }]).catch(() => {});
      } catch (e) {
        rs.controlState = prevState; // rollback
        addLog(`${roomId}: ON command failed — ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }
    return { correction: Math.abs(error) > HYSTERESIS }; // don't also adjust setpoint on transition cycle
  }

  // ── Adjust setpoint/fan within active state ──
  if (rs.controlState === activeState) {
    const fan = computeFanSpeed(roomId, temp, config, season);
    const setpoint = computeSetpoint(roomId, temp, config, season);

    const setpointChanged = rs.lastSetpoint === null || Math.abs(setpoint - rs.lastSetpoint) >= 0.5;
    const fanChanged = rs.lastFan !== fan;

    if ((setpointChanged || fanChanged) && canSendCommand(state, roomId, season)) {
      // Trend-based skip: if approaching target, don't adjust.
      // For heat, trend should be rising (>0). For cool, trend should be falling (<0).
      const goodTrend = isCool ? trend < -0.05 : trend > 0.05;
      if (error > 0 && goodTrend && Math.abs(error) < 1.5) {
        addLog(`${roomId}: ${activeState} ${temp}°C (${isCool ? 'cooling' : 'warming'}, skip adjust)`);
        return { correction: Math.abs(error) > HYSTERESIS };
      }

      try {
        if (!tokenHolder.token) tokenHolder.token = await getValidToken();
        await sendSabianaCmd(tokenHolder.token, device.deviceId, activeMode, setpoint, fan);
        rs.lastSetpoint = setpoint;
        rs.lastFan = fan;
        rs.lastCommandCycle = state.cycleCount;
        rs.commandTimestamps.push(Date.now());
        addLog(`${roomId}: ${activeState} ${temp}°C → sp=${setpoint} fan=${fan} (err=${error.toFixed(1)})`);
      } catch (e) {
        addLog(`${roomId}: adjust failed — ${e instanceof Error ? e.message : 'unknown'}`);
      }
    } else {
      addLog(`${roomId}: ${activeState} ${temp}°C (stable)`);
    }
  } else if (rs.controlState === 'SATISFIED') {
    // The agent thinks this room is satisfied (off). Reconcile with reality:
    // if the FAN IS ACTUALLY RUNNING, something turned the unit on behind the
    // agent's back — a manual PATCH or a stale blanket power-on — and left it
    // blowing while we believe it's off. In cool that means a room already
    // at/below target keeps blowing cold air it doesn't need. Re-assert OFF.
    //
    // We key off device.fanRunning, NOT device.mode: mode is the sticky byte[5]
    // thermal value that stays heat/cool even when the unit is off, so
    // `mode !== 'off'` would be true almost always and we'd fight every cycle.
    // fanRunning (byte[7] nibble 0-3) is the real "is it moving air" signal.
    //
    // Deliberately NOT reconciling a manual ON on the physical CB-Touch panel:
    // if someone switches a fancoil on by hand (e.g. emergency in Nursery's
    // room), fanRunning is true but so is the user's intent — the agent should
    // not slap it back off. We therefore only re-assert when there is NO fresh
    // user override saying "on". (override is consulted at the api/rooms layer;
    // here, the conservative rule is: reconcile only the clearly-stale case
    // where the room is SATISFIED and blowing with no recent agent command.)
    const recentlyCommanded = rs.lastCommandCycle === state.cycleCount;
    if (device.fanRunning && !recentlyCommanded && canSendCommand(state, roomId, season)) {
      try {
        if (!tokenHolder.token) tokenHolder.token = await getValidToken();
        await sendSabianaCmd(tokenHolder.token, device.deviceId, 'off', config.target, 1);
        rs.lastMode = 'off';
        rs.lastCommandCycle = state.cycleCount;
        rs.commandTimestamps.push(Date.now());
        addLog(`${roomId}: SATISFIED but device was on → re-asserted OFF at ${temp}°C`);
      } catch (e) {
        addLog(`${roomId}: OFF re-assert failed — ${e instanceof Error ? e.message : 'unknown'}`);
      }
    } else {
      addLog(`${roomId}: OFF ${temp}°C`);
    }
  }

  return { correction: Math.abs(error) > HYSTERESIS };
}
