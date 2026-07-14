/**
 * OFF-Milano guard — absence safety net.
 *
 * Milano is empty for ~3 months in season='off' and every fancoil MUST stay
 * off. The cycle's shutdown loop already RE-ASSERTS off each cycle, but a unit
 * can still escape it (a failed/ignored OFF command, a panel switch-on, a power
 * blip). This guard runs AFTER the shutdown loop, detects a fancoil that has
 * persistently failed to go off, and raises a critical alert (+ iMessage via
 * sendAlert). It performs NO actuation — read + alert only.
 *
 * Why a persistent streak and not a single-cycle check:
 *   The device states are read at the TOP of the cycle, BEFORE the shutdown
 *   commands are sent. A unit that was ON and got an OFF this same cycle still
 *   reads fanRunning=true (the read predates the command, and the Sabiana is
 *   BLE-bridged so it doesn't echo the OFF within the cycle). Alerting on that
 *   would fire a false alarm EVERY cycle a unit needed shutting down. A real
 *   "escape" is a unit that keeps reporting its fan running across MULTIPLE
 *   cycles despite repeated shutdown attempts. So we track a per-room streak in
 *   agent state (a monotonic safety ledger, merged by max on a CAS conflict)
 *   and only alert once it persists — the same shape as SENSOR_FAULT_THRESHOLD.
 *
 * Why the predicate is the bare `fanRunning` boolean (NOT deriveFancoilMode):
 *   In season='off' there is by definition no pending ON override, and which
 *   thermal mode a unit is in is irrelevant — we only care ON vs OFF. fanRunning
 *   IS the hard ON signal (an ON Sabiana always keeps its fan nibble at 0-3,
 *   even at target; only an explicit OFF parks it idle). The full
 *   deriveFancoilMode cascade exists to resolve mode + override trust, none of
 *   which applies here, so we deliberately do NOT call it — that keeps this
 *   module decoupled from the api/rooms route and leaves it byte-stable.
 *   Do not "simplify" this into calling deriveFancoilMode; it would reintroduce
 *   coupling for zero benefit.
 */

import type { AgentState, RoomState } from './state';
import { getRoomState } from './state';

/** Per-room outcome of the shutdown loop, as returned by shutdownRoomOff. */
export type ShutdownResult = 'already_off' | 'off_sent' | 'rate_limited' | 'skipped' | string;

/** Streak of consecutive escaped cycles after which the guard alerts. */
export const OFF_GUARD_ESCAPE_THRESHOLD = 2;

/**
 * Minimal device shape the guard needs. Kept structural (not the full
 * SabianaDeviceState) so it accepts both the raw device states AND the cycle's
 * post-processing variant where `temperature` may be nulled — the guard only
 * ever reads `deviceId` and `fanRunning`.
 */
export interface OffGuardDevice {
  deviceId: string;
  fanRunning: boolean;
}

export interface OffGuardInput {
  /** Top-of-cycle Sabiana device states (read BEFORE the shutdown commands). */
  devices: OffGuardDevice[];
  /** deviceId → roomId resolver (the cycle's getRoomForDevice). */
  roomForDevice: (deviceId: string) => string | undefined;
  /** Per-room shutdown outcome from this cycle's shutdown loop, keyed by roomId. */
  shutdownResults: Record<string, ShutdownResult>;
  /** Alert sink (injected so the guard is unit-testable without the proxy). */
  sendAlert: (state: AgentState, severity: string, message: string, roomId: string) => Promise<void>;
}

export interface OffGuardResult {
  /** Rooms that crossed the escape threshold this cycle and were alerted. */
  alerted: string[];
  /** Rooms currently mid-streak (fan still on, streak below threshold). */
  watching: string[];
  /** Human-readable one-liner for the cycle log. */
  message: string;
}

/**
 * Is this device evidence of a failed shutdown this cycle?
 * It must (a) still report its fan running AND (b) have had a shutdown actually
 * attempted/believed-done. A 'rate_limited' room did NOT get commanded this
 * cycle, so it's "no new evidence" — we hold the streak flat (neither advance
 * nor reset) rather than count it as an escape.
 */
function classify(fanRunning: boolean, result: ShutdownResult | undefined): 'escape' | 'clear' | 'hold' {
  if (!fanRunning) return 'clear';            // fan parked idle → genuinely off
  if (result === 'rate_limited') return 'hold'; // didn't command it; no evidence either way
  if (result === undefined || result === 'skipped') return 'hold'; // not part of shutdown this cycle
  // result is off_sent | already_off | failed:* → we believe we shut it, yet fan runs.
  return 'escape';
}

/**
 * Run the OFF-Milano guard. Caller invokes this ONLY when season==='off'
 * (Milano-implicit today; property-gated in a later phase). Mutates the per-room
 * streak in `state` and alerts on persistent escapes.
 */
export async function runOffMilanoGuard(state: AgentState, input: OffGuardInput): Promise<OffGuardResult> {
  const { devices, roomForDevice, shutdownResults, sendAlert } = input;
  const alerted: string[] = [];
  const watching: string[] = [];

  for (const device of devices) {
    const roomId = roomForDevice(device.deviceId);
    if (!roomId) continue;
    const rs: RoomState = getRoomState(state, roomId);
    const verdict = classify(device.fanRunning, shutdownResults[roomId]);

    if (verdict === 'clear') {
      rs.offGuardStillOnStreak = 0;
      continue;
    }
    if (verdict === 'hold') {
      // No new evidence this cycle — keep the streak as-is.
      if (rs.offGuardStillOnStreak > 0) watching.push(roomId);
      continue;
    }

    // escape
    rs.offGuardStillOnStreak = (rs.offGuardStillOnStreak ?? 0) + 1;
    if (rs.offGuardStillOnStreak >= OFF_GUARD_ESCAPE_THRESHOLD) {
      alerted.push(roomId);
      await sendAlert(
        state,
        'critical',
        `Milano/${roomId}: ventilconvettore ancora ACCESO dopo ${rs.offGuardStillOnStreak} cicli di spegnimento (impianto in Off globale, casa vuota) — verifica manuale`,
        roomId,
      );
    } else {
      watching.push(roomId);
    }
  }

  const message =
    alerted.length
      ? `OFF-guard: ${alerted.length} fancoil ESCAPED off (${alerted.join(',')})${watching.length ? `, watching ${watching.join(',')}` : ''}`
      : watching.length
        ? `OFF-guard: watching ${watching.join(',')} (still on, below threshold)`
        : 'OFF-guard: all fancoils confirmed off';

  return { alerted, watching, message };
}
