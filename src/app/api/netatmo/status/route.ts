import { NextResponse } from 'next/server';
import { getHomeStatus } from '@/lib/netatmo/client';
import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { loadNetatmoContext } from '@/lib/netatmo/context';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netatmo/status — current status of all Netatmo rooms.
 */
export async function GET() {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return NextResponse.json({
        ok: false,
        error: 'Netatmo non collegato. Visita /api/netatmo/auth per autenticarti.',
        needsAuth: true,
      }, { status: 401 });
    }

    // Load home_id from Supabase
    const { homeId } = await loadNetatmoContext();
    if (!homeId) {
      return NextResponse.json({ ok: false, error: 'Home ID non trovato. Ri-autenticarsi.' }, { status: 400 });
    }

    const home = await getHomeStatus(accessToken, homeId);

    return NextResponse.json({
      ok: true,
      homeId,
      rooms: home.rooms,
      modules: home.modules,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
