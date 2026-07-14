import { NextRequest, NextResponse } from 'next/server';
import { setRoomState } from '@/lib/netatmo/client';
import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { saveSetpointOverride } from '@/lib/setpoint-store';
import { assertWriteAuth } from '@/lib/auth';
import { parseBody } from '@/lib/http';
import { loadNetatmoContext } from '@/lib/netatmo/context';

export const dynamic = 'force-dynamic';

/**
 * POST /api/netatmo/setpoint — set temperature for a Netatmo room.
 * Body: { roomId: string, temperature: number, dashboardRoomId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = assertWriteAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: 'forbidden', reason: auth.reason }, { status: 403 });
  }
  try {
    const parsed = await parseBody(req, (x): {
      roomId: unknown;
      temperature: unknown;
      dashboardRoomId: unknown;
    } | null => {
      if (typeof x !== 'object' || x === null) return null;
      const o = x as Record<string, unknown>;
      return { roomId: o.roomId, temperature: o.temperature, dashboardRoomId: o.dashboardRoomId };
    });
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const { roomId, temperature, dashboardRoomId } = parsed.data;

    if (typeof roomId !== 'string' || !/^[0-9]{1,20}$/.test(roomId)) {
      return NextResponse.json({ ok: false, error: 'invalid_roomId' }, { status: 400 });
    }
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 7 || temperature > 30) {
      return NextResponse.json({ ok: false, error: 'temperature_out_of_range' }, { status: 400 });
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return NextResponse.json({ ok: false, error: 'Netatmo non collegato', needsAuth: true }, { status: 401 });
    }

    // Load home_id
    const { homeId } = await loadNetatmoContext();
    if (!homeId) {
      return NextResponse.json({ ok: false, error: 'home_id_not_found' }, { status: 400 });
    }

    // Set manual setpoint — permanent until next schedule change.
    // Omit end_time so Netatmo holds until the schedule flips it.
    await setRoomState(accessToken, homeId, roomId, 'manual', temperature);

    // Persist override so it survives page refresh
    if (typeof dashboardRoomId === 'string') {
      await saveSetpointOverride(dashboardRoomId, temperature);
    }

    return NextResponse.json({ ok: true, roomId, temperature });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('[netatmo/setpoint] error:', message);
    return NextResponse.json({ ok: false, error: 'setpoint_failed' }, { status: 500 });
  }
}
