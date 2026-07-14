/**
 * Sonoff bridge reader — SINGLE SOURCE OF TRUTH for room temperatures.
 *
 * Pipeline (cloud-only, NO Mac dependency):
 *
 *   Sonoff SNZB-02D (Zigbee) → Homey Pro hub (192.168.1.x, runs the
 *   `thermoleo-bridge` SDK 3 app that polls every 2 min) → HTTPS POST to
 *   `/api/sensors/ingest` on Vercel → upserts `sonoff_bridge` table on
 *   Supabase → this module reads it during the agent cycle.
 *
 * The old `scripts/sonoff-bridge.sh` on the always-on Mac is DEPRECATED.
 * Do not re-enable it. If sonoff_bridge ever shows fresh updated_at but
 * the room temps are bogus, the issue is on the Homey app side (NOT the
 * Mac, NOT this module).
 *
 * This module is the ONLY way the webapp reads room temperatures.
 * The old OAuth cloud client (`getSonoffReadings` in `lib/homey/client.ts`)
 * is dead: Athom never grants the required scope, so that path always
 * returned `{}` while adding ~5s of timeout to every agent cycle.
 *
 * The helper exposes two readers:
 * - `loadBridgeReadings()`     — only rows <5min old (agent cycle, commands).
 * - `loadBridgeReadingsRaw()`  — every row with its age (UI, staleness banners).
 *
 * Never fall back to Sabiana's built-in T1 probe for user-visible values
 * or agent decisions: T1 sits in the cold mandata and reads ~5°C below
 * the real ambient, AND it drifts to random junk (e.g. 11°C) whenever the
 * fancoil is off. The agent uses Sonoff truth; if Sonoff is stale the
 * room enters SENSOR_FAULT (defensive actuation for Nursery, off for others)
 * — that's the only safe behaviour.
 */

const BRIDGE_FRESHNESS_MS = 5 * 60 * 1000; // 5 min — max age for "fresh"
const FETCH_TIMEOUT_MS = 5000;

export interface BridgeReading {
  temperature: number;
  humidity: number | null;
}

export interface BridgeReadingRaw extends BridgeReading {
  /** ISO timestamp of the last ingest. Null if the row has no updated_at. */
  updatedAt: string | null;
  /** Age in milliseconds since last update, or `Infinity` when unknown. */
  ageMs: number;
  /** True when older than `BRIDGE_FRESHNESS_MS`. */
  stale: boolean;
}

interface RawRow {
  room_id: string;
  temperature: number | string;
  humidity: number | string | null;
  updated_at: string | null;
}

function supabaseHeaders() {
  // The anon key is sufficient: `sonoff_bridge` has an open RLS policy
  // (`allow_all_sonoff_bridge`). Security on the write path is the
  // `x-ingest-secret` header on `/api/sensors/ingest`, not Supabase auth.
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error('SUPABASE key missing: set SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function fetchBridgeRows(): Promise<RawRow[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return [];
  try {
    const res = await fetch(
      // property_id=milano: this reader serves the MILANO cycle only. The table
      // is shared (Campomarino Shelly write campomarino_* rows here too) — without
      // this filter Milano's sensor count would include them (Sensors: 10/7).
      `${url}/rest/v1/sonoff_bridge?select=room_id,temperature,humidity,updated_at&property_id=eq.milano`,
      {
        headers: supabaseHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      console.error('[bridge] sonoff_bridge query failed:', res.status, await res.text().catch(() => ''));
      return [];
    }
    return await res.json() as RawRow[];
  } catch (e) {
    console.error('[bridge] fetch error:', e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Fresh-only readings map keyed by room_id. Rows older than 5 minutes are
 * dropped entirely — callers that need this map can trust every value is
 * actionable. Use this in the agent cycle and in command paths.
 */
export async function loadBridgeReadings(): Promise<Record<string, BridgeReading>> {
  const rows = await fetchBridgeRows();
  const cutoff = Date.now() - BRIDGE_FRESHNESS_MS;
  const map: Record<string, BridgeReading> = {};
  for (const r of rows) {
    if (!r.updated_at) continue;
    if (new Date(r.updated_at).getTime() <= cutoff) continue;
    // Guard against NaN: a blank/non-numeric DB temperature would otherwise
    // slip past every `=== null` check downstream (NaN != null) and poison the
    // agent's arithmetic / encode a malformed Sabiana command. Skip the row
    // entirely so the fallback chain treats it as a missing sensor.
    const t = Number(r.temperature);
    if (!Number.isFinite(t)) continue;
    const h = r.humidity != null ? Number(r.humidity) : null;
    map[r.room_id] = {
      temperature: t,
      humidity: h != null && Number.isFinite(h) ? h : null,
    };
  }
  return map;
}

/**
 * Every row with its age and a `stale` flag. Use this in UI-facing paths
 * (e.g. `/api/rooms`) so the client can render staleness banners and
 * refuse to show stale numbers as if they were live.
 */
export async function loadBridgeReadingsRaw(): Promise<Record<string, BridgeReadingRaw>> {
  const rows = await fetchBridgeRows();
  const now = Date.now();
  const map: Record<string, BridgeReadingRaw> = {};
  for (const r of rows) {
    const updatedAt = r.updated_at;
    const ts = updatedAt ? new Date(updatedAt).getTime() : NaN;
    const ageMs = Number.isFinite(ts) ? now - ts : Infinity;
    // NaN guard, UI-facing: a non-numeric DB value would render as a live
    // number. Skip the row so the UI shows "sensor offline" rather than NaN.
    const t = Number(r.temperature);
    if (!Number.isFinite(t)) continue;
    const h = r.humidity != null ? Number(r.humidity) : null;
    map[r.room_id] = {
      temperature: t,
      humidity: h != null && Number.isFinite(h) ? h : null,
      updatedAt: updatedAt ?? null,
      ageMs,
      stale: ageMs > BRIDGE_FRESHNESS_MS,
    };
  }
  return map;
}

export const BRIDGE_FRESHNESS_THRESHOLD_MS = BRIDGE_FRESHNESS_MS;

// ── Campomarino Shelly H&T ──────────────────────────────────────────────────
// The Shelly H&T G3 (USB) transmits every ~5 min, not always-on, so a 7-min
// cutoff covers one cycle + margin (a 5-min window would read stale between
// pushes → false sensor-fault). Shared readings table, filtered to the 3
// campomarino_* room ids (Milano's bare ids are never matched).
const SHELLY_FRESHNESS_MS = 7 * 60 * 1000;
const CAMPOMARINO_ROOM_IDS = ['campomarino_studio', 'campomarino_camera', 'campomarino_soggiorno'];

/** Fresh (≤7min) Shelly temp+humidity for the 3 campomarino rooms, keyed by room_id. */
export async function loadShellyCampomarino(): Promise<Record<string, BridgeReading>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return {};
  let rows: RawRow[] = [];
  try {
    const inList = CAMPOMARINO_ROOM_IDS.join(',');
    const res = await fetch(
      `${url}/rest/v1/sonoff_bridge?select=room_id,temperature,humidity,updated_at&room_id=in.(${inList})`,
      { headers: supabaseHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' },
    );
    if (!res.ok) return {};
    rows = await res.json() as RawRow[];
  } catch { return {}; }
  const cutoff = Date.now() - SHELLY_FRESHNESS_MS;
  const map: Record<string, BridgeReading> = {};
  for (const r of rows) {
    if (!r.updated_at || new Date(r.updated_at).getTime() <= cutoff) continue;
    const t = Number(r.temperature);
    if (!Number.isFinite(t)) continue;
    const h = r.humidity != null ? Number(r.humidity) : null;
    map[r.room_id] = { temperature: t, humidity: h != null && Number.isFinite(h) ? h : null };
  }
  return map;
}
