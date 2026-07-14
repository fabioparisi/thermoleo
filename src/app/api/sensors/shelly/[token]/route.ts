/**
 * Shelly H&T Gen3 ingest (Campomarino).
 *
 * The 3 Shelly H&T Gen3 sensors push a GET request via Webhook.Create on every
 * temperature/humidity change (and periodically). Unlike the Homey bridge (POST
 * + JSON body + x-ingest-secret header), Shelly webhooks can't set custom
 * headers easily, so:
 *   - auth travels as a PATH SEGMENT (/api/sensors/shelly/<token>), a dedicated
 *     rotatable token (THERMOLEO_SHELLY_TOKEN) distinct from Milano's ingest
 *     secret. Path segments are redacted from Vercel request logs (the path is
 *     logged but we keep the token out of querystring where it's most visible).
 *   - one reading per request (a single room), normalized into the SAME
 *     `sonoff_bridge` upsert the Homey path uses — with a `campomarino_*` room
 *     id, so Milano's bare-id rows can't collide and Milano stays byte-identical.
 *
 * Example webhook URL configured on each Shelly:
 *   https://your-deployment.vercel.app/api/sensors/shelly/<token>?room=campomarino_studio&temp=${ev.tC}&hum=${status["humidity:0"].rh}
 *
 * Security: temp/hum plausibility-gated; room must be a known campomarino room.
 * A leaked token's worst case is a spoofed reading, mitigated by the room
 * allowlist + plausibility gate + rotatable token.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SHELLY_TOKEN = process.env.THERMOLEO_SHELLY_TOKEN || '';

// Campomarino rooms that may report via Shelly. Hardcoded allowlist (not a DB
// lookup) so a DB blip can't fail-open to accept arbitrary ids on this public,
// token-only endpoint. Keep in sync with the rooms table / topology.
const CAMPOMARINO_ROOMS = new Set([
  'campomarino_studio',
  'campomarino_camera',
  'campomarino_soggiorno',
]);

/** Constant-time-ish token compare (avoids early-exit length/prefix leak). */
function tokenOk(provided: string): boolean {
  if (!SHELLY_TOKEN || provided.length !== SHELLY_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ SHELLY_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!SHELLY_TOKEN) {
    return NextResponse.json({ error: 'ingest_disabled' }, { status: 503 });
  }
  const { token } = await params;
  if (!tokenOk(token)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const room = sp.get('room') ?? '';
  if (!CAMPOMARINO_ROOMS.has(room)) {
    return NextResponse.json({ error: 'unknown_room' }, { status: 400 });
  }

  const temp = Number(sp.get('temp'));
  // Plausibility gate: a real indoor sensor sits well inside 5..45°C. Anything
  // outside is a broken/unparseable reading — reject rather than poison the agent.
  if (!Number.isFinite(temp) || temp <= 5 || temp >= 45) {
    return NextResponse.json({ error: 'implausible_temp', got: sp.get('temp') }, { status: 400 });
  }

  // Humidity optional (a humidity.change webhook may omit temp's partner and
  // vice-versa). Accept 0..100, else store null.
  const rawHum = sp.get('hum');
  let humidity: number | null = null;
  if (rawHum !== null) {
    const h = Number(rawHum);
    if (Number.isFinite(h) && h >= 0 && h <= 100) humidity = h;
  }

  const now = new Date().toISOString();
  const row = {
    room_id: room,
    // sonoff_bridge has a CHECK that ties property_id to the room_id prefix:
    // non-milano rooms require property_id + '_' prefix. Must set it explicitly
    // (column defaults to 'milano', which would violate the check for campomarino_*).
    property_id: 'campomarino',
    temperature: temp,
    humidity,
    last_changed: now,
    updated_at: now,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/sonoff_bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([row]),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return NextResponse.json(
      { error: 'supabase_error', status: res.status, detail: body.slice(0, 200) },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, room, temp, humidity });
}
