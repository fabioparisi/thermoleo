import { NextRequest, NextResponse } from 'next/server';
import { sendCommand } from '@/lib/sabiana/client';
import { getValidToken } from '@/lib/sabiana/token-manager';
import { saveSetpointOverride } from '@/lib/setpoint-store';
import type { SabianaCommand, SabianaMode } from '@/lib/sabiana/types';
import { getRoomForDevice } from '@/lib/rooms';
import { assertWriteAuth } from '@/lib/auth';
import { parseBody } from '@/lib/http';
import { loadTopology } from '@/lib/topology';

// Allowed Sabiana device ids now derive from the `rooms` table (Phase 3a) — the
// single source of truth — instead of a hardcoded Set. Equivalence to the old
// list is pinned by tests/unit/topology.test.ts.

const VALID_MODES: ReadonlySet<SabianaMode> = new Set<SabianaMode>(['heat', 'cool', 'fan_only', 'off']);

export async function POST(request: NextRequest) {
  const auth = assertWriteAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: 'forbidden', reason: auth.reason }, { status: 403 });
  }

  const parsed = await parseBody(request, (x): {
    deviceId: unknown;
    temperature: unknown;
    fan: unknown;
    mode: unknown;
    swing: unknown;
    preset: unknown;
  } | null => {
    if (typeof x !== 'object' || x === null) return null;
    const o = x as Record<string, unknown>;
    return {
      deviceId: o.deviceId,
      temperature: o.temperature,
      fan: o.fan,
      mode: o.mode,
      swing: o.swing,
      preset: o.preset,
    };
  });
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const { deviceId, temperature, fan, mode, swing, preset } = parsed.data;

  const allowedDeviceIds = new Set((await loadTopology()).sabianaDeviceIds);
  if (typeof deviceId !== 'string' || !allowedDeviceIds.has(deviceId)) {
    return NextResponse.json({ ok: false, error: 'invalid_deviceId' }, { status: 400 });
  }
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 15 || temperature > 30) {
      return NextResponse.json({ ok: false, error: 'temperature_out_of_range' }, { status: 400 });
    }
  }
  if (mode !== undefined && !(typeof mode === 'string' && VALID_MODES.has(mode as SabianaMode))) {
    return NextResponse.json({ ok: false, error: 'invalid_mode' }, { status: 400 });
  }

  try {
    const cmd: SabianaCommand = {
      fan: typeof fan === 'number' ? fan : 4,
      mode: (mode as SabianaMode) ?? 'heat',
      temperature: typeof temperature === 'number' ? temperature : 22,
      swing: typeof swing === 'number' ? swing : 4,
      preset: typeof preset === 'number' ? preset : 0,
    };

    // Persist setpoint override BEFORE sending command so it survives page refresh
    // even if the command response is slow or returns false.
    const roomId = getRoomForDevice(deviceId);
    if (roomId) {
      await saveSetpointOverride(roomId, cmd.temperature, cmd.fan, cmd.mode);
    }

    const token = await getValidToken();
    const result = await sendCommand(token, deviceId, cmd);

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[sabiana/command] error:', message);
    return NextResponse.json({ ok: false, error: 'command_failed' }, { status: 500 });
  }
}
