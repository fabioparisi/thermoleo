/**
 * Webhook for the ThermoLeo Bridge Homey app.
 * The app POSTs Sonoff readings every 2 minutes; we upsert them into
 * `sonoff_bridge` so the agent cycle picks them up exactly like the old
 * Mac-bridge path.
 *
 * Security: requires `x-ingest-secret` header matching THERMOLEO_INGEST_SECRET
 * env var. Without this, anyone could push fake readings.
 */

import { NextResponse } from 'next/server';
import { loadTopology } from '@/lib/topology';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// sonoff_bridge has an open RLS policy (allow_all_sonoff_bridge). The anon key
// is sufficient; service-role is used only if explicitly provided. Security is
// enforced by INGEST_SECRET below, not by Supabase auth.
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const INGEST_SECRET = process.env.THERMOLEO_INGEST_SECRET || '';

interface IncomingReading {
  room_id: string;
  temperature: number;
  humidity: number | null;
  last_updated?: string;
}

// Valid room ids derive from the `rooms` table (Phase 3a); equivalence to the
// old hardcoded set is pinned by tests/unit/topology.test.ts. If the topology
// load fails (DB blip), we FAIL OPEN — accept the reading rather than reject it:
// a sensor blackout (rejecting every push) is worse than letting an unknown
// room_id land in sonoff_bridge (the agent only reads known rooms, so a stray
// row is inert). The known-room filter is a hygiene check, not a security gate
// (that's the x-ingest-secret header above).
async function validRoomFilter(): Promise<(roomId: string) => boolean> {
  try {
    const { roomIds } = await loadTopology();
    return (roomId: string) => roomIds.has(roomId);
  } catch {
    console.error('[ingest] topology load failed — failing open (accept all rooms this push)');
    return () => true;
  }
}

export async function POST(request: Request) {
  if (!INGEST_SECRET) {
    return NextResponse.json({ error: 'ingest_disabled' }, { status: 503 });
  }
  const provided = request.headers.get('x-ingest-secret');
  if (provided !== INGEST_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let payload: { readings?: IncomingReading[] };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const readings = payload.readings;
  if (!Array.isArray(readings) || readings.length === 0) {
    return NextResponse.json({ error: 'empty_readings' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const isValidRoom = await validRoomFilter();
  const rows = readings
    .filter(r => isValidRoom(r.room_id))
    .filter(r => typeof r.temperature === 'number' && r.temperature >= -10 && r.temperature <= 50)
    .map(r => ({
      room_id: r.room_id,
      temperature: r.temperature,
      humidity: r.humidity ?? null,
      // last_changed = real Zigbee timestamp from the Homey app (when the
      // sensor itself last reported). Used for monitoring sleepy-end-device
      // health, NOT for agent freshness (the agent uses updated_at, which
      // is refreshed on every push so it always reflects "data flowed
      // through the pipeline recently").
      last_changed: r.last_updated ?? now,
      updated_at: now,
    }));

  if (rows.length === 0) {
    return NextResponse.json({ error: 'no_valid_readings' }, { status: 400 });
  }

  // Upsert: each room is a single row, refreshed on every push
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sonoff_bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return NextResponse.json(
      { error: 'supabase_error', status: res.status, detail: body.slice(0, 200) },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, accepted: rows.length, rooms: rows.map(r => r.room_id) });
}
