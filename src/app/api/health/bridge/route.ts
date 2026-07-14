/**
 * Dead-man's-switch health endpoint for the Sonoff bridge.
 *
 * Reads sonoff_bridge (7 rows: leone, studio, camera, soggiorno, cucina, bagno1, bagno2)
 * and alerts if rows are stale (>10 min since updated_at).
 *
 * Alert conditions:
 * - leone stale → CRITICAL "🚨 Nursery sensor stale [Xm]"  → iMessage (every 30min max)
 * - >3 rooms stale → WARNING "⚠️ Bridge degraded: N/7 rooms fresh" → iMessage (every 30min max)
 * - all fresh → silent 200 OK
 *
 * Debounce: queries alerts table for last alert of same severity sent to _bridge.
 * No agent state needed — keeps this route self-contained.
 *
 * Endpoint pulled by the UI for the health banner. The agent cycle
 * also fires its own alert when bridgeUsed === 0 (see cycle/route.ts),
 * so this route is the diagnostic/monitoring path, not a scheduled cron.
 * No auth required (UI hits it; alert spam is rate-limited via cooldown).
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// ─── Config ───────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 10 * 60 * 1000;   // 10 min — fresh window
const ALERT_COOLDOWN_MS  = 30 * 60 * 1000;   // 30 min between same-severity alerts
const DEGRADED_THRESHOLD = 3;                 // >3 stale rooms → WARNING

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const IMESSAGE_PROXY_URL = process.env.IMESSAGE_PROXY_URL || 'http://localhost:9100';
const IMESSAGE_RECIPIENT = process.env.IMESSAGE_RECIPIENT || 'fabioparisi@me.com';

// ─── Supabase helpers ─────────────────────────────────────────────────────────

function supaHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

// ─── Bridge staleness check ───────────────────────────────────────────────────

interface BridgeRow {
  room_id: string;
  updated_at: string;
}

interface RoomHealth {
  age_seconds: number;
  stale: boolean;
}

async function fetchBridgeHealth(): Promise<{
  rooms: Record<string, RoomHealth>;
  worst_age_seconds: number;
  leone_stale: boolean;
  total_rooms_fresh: number;
  total_rooms: number;
}> {
  const res = await fetch(
    // Milano-only (table is shared with Campomarino Shelly rows now).
    `${SUPABASE_URL}/rest/v1/sonoff_bridge?select=room_id,updated_at&property_id=eq.milano`,
    { headers: supaHeaders(), signal: AbortSignal.timeout(8000) },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sonoff_bridge query failed: ${res.status} ${body.slice(0, 100)}`);
  }

  const rows = await res.json() as BridgeRow[];
  const now = Date.now();

  const rooms: Record<string, RoomHealth> = {};
  let worst_age_seconds = 0;
  let leone_stale = false;
  let total_rooms_fresh = 0;

  for (const row of rows) {
    const age_ms = now - new Date(row.updated_at).getTime();
    const age_seconds = Math.floor(age_ms / 1000);
    const stale = age_ms > STALE_THRESHOLD_MS;

    rooms[row.room_id] = { age_seconds, stale };

    if (age_seconds > worst_age_seconds) worst_age_seconds = age_seconds;
    if (row.room_id === 'leone' && stale) leone_stale = true;
    if (!stale) total_rooms_fresh++;
  }

  return {
    rooms,
    worst_age_seconds,
    leone_stale,
    total_rooms_fresh,
    total_rooms: rows.length,
  };
}

// ─── Debounce: last alert of a given severity for _bridge ─────────────────────

async function getLastAlertAt(severity: string): Promise<number> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/alerts?room_id=eq._bridge&severity=eq.${severity}&order=created_at.desc&limit=1&select=created_at`,
      { headers: supaHeaders(), signal: AbortSignal.timeout(5000) },
    );
    const rows = await res.json();
    if (rows?.length) return new Date(rows[0].created_at).getTime();
  } catch { /* silent */ }
  return 0;
}

// ─── Alert sender ─────────────────────────────────────────────────────────────

async function sendBridgeAlert(severity: 'critical' | 'warning', message: string): Promise<void> {
  // Debounce: skip if same-severity alert was sent within cooldown window
  const lastAlertAt = await getLastAlertAt(severity);
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) {
    console.log(`[bridge-health] ${severity} alert suppressed (cooldown active, last=${new Date(lastAlertAt).toISOString()})`);
    return;
  }

  console.log(`[bridge-health] ALERT ${severity}: ${message}`);

  // iMessage
  try {
    await fetch(`${IMESSAGE_PROXY_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: IMESSAGE_RECIPIENT, message: `🌡️ ThermoLeo [${severity}]: ${message}` }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* proxy unreachable from Vercel — alert still logged to DB */ }

  // Persist to alerts table (matching cycle route pattern)
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/alerts`, {
      method: 'POST',
      headers: { ...supaHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify([{
        room_id: '_bridge',
        severity,
        message,
        created_at: new Date().toISOString(),
      }]),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* silent */ }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const health = await fetchBridgeHealth();

    const {
      rooms,
      worst_age_seconds,
      leone_stale,
      total_rooms_fresh,
      total_rooms,
    } = health;

    const stale_count = total_rooms - total_rooms_fresh;
    const ok = !leone_stale && stale_count <= DEGRADED_THRESHOLD;

    // Fire alerts (in priority order — leone first, then degraded)
    if (leone_stale) {
      const age_min = Math.floor((rooms['leone']?.age_seconds ?? 0) / 60);
      await sendBridgeAlert(
        'critical',
        `🚨 Nursery sensor stale [${age_min}m] — Homey Flow may have stopped pushing data`,
      );
    } else if (stale_count > DEGRADED_THRESHOLD) {
      await sendBridgeAlert(
        'warning',
        `⚠️ Bridge degraded: ${total_rooms_fresh}/${total_rooms} rooms fresh (${stale_count} stale)`,
      );
    }

    return NextResponse.json({
      ok,
      rooms,
      worst_age_seconds,
      leone_stale,
      total_rooms_fresh,
      total_rooms,
    }, {
      status: ok ? 200 : (leone_stale ? 503 : 200),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.error(`[bridge-health] fatal: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
