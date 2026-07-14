/**
 * Unit tests for the OFF-Milano guard streak logic.
 *
 * The guard's whole reason to exist is to tell a same-cycle BLE echo race
 * ("I just commanded this off, it hasn't echoed yet") apart from a real escape
 * ("this unit keeps ignoring the OFF across cycles"). These tests pin that
 * behavior deterministically, with no hardware/network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOffMilanoGuard, OFF_GUARD_ESCAPE_THRESHOLD, type OffGuardInput } from '../../src/lib/agent/off-guard';
import type { AgentState } from '../../src/lib/agent/state';

// Minimal AgentState factory — the guard only touches roomStates via getRoomState.
function freshState(): AgentState {
  return {
    cycleCount: 0,
    roomStates: {},
    originalThermostatSetpoint: null,
    lastThermostatCommandTime: 0,
    alertCooldowns: {},
    lastCycleTime: 0,
    correcting: false,
    sentinelActive: false,
    lastSentinelCommandTime: 0,
    bathroomsAntifrozenAt: null,
    smartherSummerOpenAt: null,
    smartherClosedAt: null,
  } as AgentState;
}

function makeInput(
  partial: Partial<OffGuardInput> & Pick<OffGuardInput, 'devices' | 'shutdownResults'>,
): OffGuardInput {
  return {
    roomForDevice: (id: string) => id.replace('dev_', ''), // dev_leone → leone
    sendAlert: vi.fn(async () => {}),
    ...partial,
  };
}

describe('runOffMilanoGuard', () => {
  let state: AgentState;
  beforeEach(() => { state = freshState(); });

  it('threshold is 2 (one extra cycle absorbs the BLE echo race)', () => {
    expect(OFF_GUARD_ESCAPE_THRESHOLD).toBe(2);
  });

  it('does NOT alert on the first cycle a fancoil is shut down (echo race)', async () => {
    const sendAlert = vi.fn(async () => {});
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }], // top-of-cycle read, pre-command
      shutdownResults: { leone: 'off_sent' },
      sendAlert,
    }));
    expect(sendAlert).not.toHaveBeenCalled();
    expect(r.alerted).toEqual([]);
    expect(r.watching).toEqual(['leone']);
    expect(state.roomStates.leone.offGuardStillOnStreak).toBe(1);
  });

  it('alerts once the fancoil stays ON for a 2nd consecutive shutdown cycle', async () => {
    const sendAlert = vi.fn(async () => {});
    // cycle 1
    await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'off_sent' },
      sendAlert,
    }));
    // cycle 2 — still on despite another shutdown attempt
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'off_sent' },
      sendAlert,
    }));
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(state, 'critical', expect.stringContaining('Milano/leone'), 'leone');
    expect(r.alerted).toEqual(['leone']);
    expect(state.roomStates.leone.offGuardStillOnStreak).toBe(2);
  });

  it('resets the streak when the fan finally parks idle (recovery)', async () => {
    const sendAlert = vi.fn(async () => {});
    await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'off_sent' }, sendAlert,
    }));
    expect(state.roomStates.leone.offGuardStillOnStreak).toBe(1);
    // next cycle the OFF took effect → fan idle
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: false }],
      shutdownResults: { leone: 'already_off' }, sendAlert,
    }));
    expect(state.roomStates.leone.offGuardStillOnStreak).toBe(0);
    expect(r.alerted).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('holds (does not advance) the streak on a rate_limited cycle (no command sent)', async () => {
    const sendAlert = vi.fn(async () => {});
    // cycle 1: escape → streak 1
    await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'off_sent' }, sendAlert,
    }));
    // cycle 2: rate-limited (didn't command) → streak stays 1, no alert
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'rate_limited' }, sendAlert,
    }));
    expect(state.roomStates.leone.offGuardStillOnStreak).toBe(1);
    expect(r.alerted).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('treats a failed shutdown that stays on as an escape', async () => {
    const sendAlert = vi.fn(async () => {});
    await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'failed: 503 from sabiana' }, sendAlert,
    }));
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_leone', fanRunning: true }],
      shutdownResults: { leone: 'failed: 503 from sabiana' }, sendAlert,
    }));
    expect(r.alerted).toEqual(['leone']);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('a fancoil that was never on is confirmed off immediately, no streak', async () => {
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'dev_soggiorno', fanRunning: false }],
      shutdownResults: { soggiorno: 'already_off' },
    }));
    expect(r.message).toMatch(/all fancoils confirmed off/);
    expect(state.roomStates.soggiorno.offGuardStillOnStreak).toBe(0);
  });

  it('handles multiple rooms independently (one escapes, one fine)', async () => {
    const sendAlert = vi.fn(async () => {});
    const input = () => makeInput({
      devices: [
        { deviceId: 'dev_leone', fanRunning: true },
        { deviceId: 'dev_camera', fanRunning: false },
      ],
      shutdownResults: { leone: 'off_sent', camera: 'already_off' },
      sendAlert,
    });
    await runOffMilanoGuard(state, input());
    const r = await runOffMilanoGuard(state, input());
    expect(r.alerted).toEqual(['leone']);
    expect(state.roomStates.camera.offGuardStillOnStreak).toBe(0);
    expect(state.roomStates.leone.offGuardStillOnStreak).toBe(2);
  });

  it('ignores devices with no room mapping', async () => {
    const r = await runOffMilanoGuard(state, makeInput({
      devices: [{ deviceId: 'unmapped_xyz', fanRunning: true }],
      shutdownResults: {},
      roomForDevice: () => undefined,
    }));
    expect(r.alerted).toEqual([]);
    expect(r.watching).toEqual([]);
  });
});
