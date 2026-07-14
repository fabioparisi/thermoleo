import { NextResponse } from 'next/server';
import { getDeviceStates } from '@/lib/sabiana/client';
import { getValidToken } from '@/lib/sabiana/token-manager';
import { getRoomForDevice } from '@/lib/rooms';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const token = await getValidToken();
    const states = await getDeviceStates(token);

    const rooms = states.map((s) => ({
      roomId: getRoomForDevice(s.deviceId) || s.deviceId,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      temperature: s.temperature,
      setpoint: s.setpoint,
      setpointCool: s.setpointCool,
      setpointHeat: s.setpointHeat,
      setpointAuto: s.setpointAuto,
      fanSpeed: s.fanSpeed,
      fanSpeedRaw: s.fanSpeedRaw,
      flapPosition: s.flapPosition,
      mode: s.mode,
      connectionUp: s.connectionUp,
      modelType: s.modelType,
    }));

    return NextResponse.json({ ok: true, rooms, timestamp: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
