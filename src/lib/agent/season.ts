/**
 * Season flag loader.
 *
 * Semantics:
 *   - 'heat' → winter mode, boiler provides hot water. Agent manages fancoils
 *     + bathroom valves + thermostat override as usual.
 *   - 'cool' → summer mode, chiller provides cold water (condominio activates
 *     it, usually late May). Agent will manage cooling (future work; treated
 *     the same as 'heat' today — reconsidered when cool logic lands).
 *   - 'off'  → interregno / shutdown period. No hot OR cold water in the
 *     building circuit (Milano zona E: after 15-apr legal heating cutoff,
 *     before the chiller is activated). Automatic commands are suspended:
 *     fancoils keep the user's last manual state, bathroom valves are forced
 *     to antifreeze (7°C via Netatmo) to prevent humidity condensing on cold
 *     radiator bodies. Nursery safety invariants stay ARMED (any emergency
 *     will still try to fire, even if hardware can't deliver — at least the
 *     alert reaches Fabio).
 *
 * Storage: `tokens` row with `provider='settings'`, `data={
 *   season: 'heat'|'cool'|'off',
 *   source: 'calendar'|'manual'|'override',  // who set the current value
 *   override: { season, start, end, reason } | null
 * }`.
 *
 * Fail-safe: on any read error, returns 'heat' (keeps full logic active,
 * which is the pre-existing behaviour before this flag).
 */

import type { SeasonOverride, SeasonSource } from './season-calendar';
import { providerKey } from '@/lib/supabase/rest';

const PROVIDER = 'settings';

export type Season = 'heat' | 'cool' | 'off';

export interface SeasonSettings {
  season: Season;
  source: SeasonSource | 'manual';
  override: SeasonOverride | null;
}

const DEFAULT_SEASON: Season = 'heat';
const DEFAULT_SETTINGS: SeasonSettings = {
  season: DEFAULT_SEASON,
  source: 'manual',
  override: null,
};
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: SeasonSettings;
  expires: number;
}

// Cache keyed BY PROPERTY. A module-global single cache would let a campomarino
// cycle on a warm Lambda serve its season to a Milano read and blind the
// OFF-guard (R1/R-S14). One entry per propertyId keeps them isolated.
const cache = new Map<string, CacheEntry>();

function supaHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

function parseSeason(raw: unknown): Season {
  if (raw === 'cool' || raw === 'off' || raw === 'heat') return raw;
  return DEFAULT_SEASON;
}

function parseSource(raw: unknown): SeasonSettings['source'] {
  if (raw === 'calendar' || raw === 'override' || raw === 'manual') return raw;
  return 'manual';
}

function parseOverride(raw: unknown): SeasonOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const season = o.season;
  const start = o.start;
  const end = o.end;
  const reason = o.reason;
  if (
    (season !== 'heat' && season !== 'cool' && season !== 'off') ||
    typeof start !== 'string' ||
    typeof end !== 'string' ||
    typeof reason !== 'string'
  ) {
    return null;
  }
  // Loose YYYY-MM-DD shape check.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  return { season, start, end, reason };
}

/**
 * Fetch + parse one `settings` row by exact provider key.
 * Returns the parsed settings, or `null` when the row is absent (so the caller
 * can fall back to the nude row). THROWS on HTTP / network error so the caller
 * can distinguish "no row" (fall back) from "couldn't read" (fail-safe heat).
 */
async function fetchSeasonRow(provider: string): Promise<SeasonSettings | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const res = await fetch(
    `${url}/rest/v1/tokens?provider=eq.${encodeURIComponent(provider)}&select=data`,
    { headers: supaHeaders(), signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`supabase status ${res.status}`);
  const rows = (await res.json()) as Array<{ data: Record<string, unknown> | string }>;
  if (!rows.length) return null;
  const raw = rows[0].data;
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  return {
    season: parseSeason(parsed?.season),
    source: parseSource(parsed?.source),
    override: parseOverride(parsed?.override),
  };
}

export async function loadSeasonSettings(propertyId = 'milano'): Promise<SeasonSettings> {
  const now = Date.now();
  const cached = cache.get(propertyId);
  if (cached && cached.expires > now) return cached.value;

  try {
    // Suffixed first; nude-fallback during the Phase 5→6 drain. The fallback is
    // what keeps `off` honest: an absent suffixed row reads the nude row's REAL
    // season instead of silently defaulting to 'heat' and turning the empty
    // house back on. A genuine read error still fails safe to 'heat' below.
    const settings =
      (await fetchSeasonRow(providerKey(PROVIDER, propertyId))) ??
      (await fetchSeasonRow(PROVIDER)) ??
      DEFAULT_SETTINGS;
    cache.set(propertyId, { value: settings, expires: now + CACHE_TTL_MS });
    return settings;
  } catch (e) {
    console.warn('[season] load failed, fail-safe to heat:', e instanceof Error ? e.message : e);
    // Do NOT cache failures — retry on next call.
    return DEFAULT_SETTINGS;
  }
}

/** Back-compat helper for callers that only need the current season string. */
export async function loadSeason(propertyId = 'milano'): Promise<Season> {
  return (await loadSeasonSettings(propertyId)).season;
}

/**
 * Test/write seam: forget cached season so the next load hits Supabase.
 * Pass a propertyId to clear just that property; omit to clear ALL properties.
 * Called by the settings route after a season write so the OFF-guard never
 * serves a stale season from a warm Lambda's cache.
 */
export function __resetSeasonCache(propertyId?: string) {
  if (propertyId) cache.delete(propertyId);
  else cache.clear();
}
