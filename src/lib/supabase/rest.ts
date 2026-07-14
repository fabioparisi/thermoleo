/**
 * Shared Supabase REST helpers for ThermoLeo API routes.
 *
 * All routes that hit Supabase via the REST API (not the JS client) should
 * use these helpers instead of inlining the key fallback and fetch patterns.
 *
 * Convention:
 *  - Default timeout for GETs: 8 000 ms
 *  - Default timeout for writes: 10 000 ms
 *  - On !ok responses: logs server-side (never echoes body to caller) and throws.
 */

import type { TokenRow } from './types';

// ─── Provider namespacing ───────────────────────────────────────────────────────

/**
 * Suffix a per-property `tokens` provider with the property id.
 *
 * The three per-property providers (`agent_state`, `setpoint_overrides`,
 * `settings`) are namespaced `<base>:<propertyId>` so two homes never clobber
 * each other's row (and so two concurrent Milano cycles CAS against the same
 * suffixed row instead of racing on a global one). Suffixing is unconditional —
 * there is no `'milano'` special-case, so there's no nude/suffixed branching to
 * maintain once the nude rows are dropped (Phase 6).
 *
 * Vendor tokens (`netatmo_home`, `sabiana_*`, `homey_*`, …) are NOT per-property
 * and stay nude — they go through `supaGetTokenData`/`supaUpsertToken` directly,
 * which never call this.
 */
export function providerKey(base: string, propertyId = 'milano'): string {
  return `${base}:${propertyId}`;
}

// ─── URL + headers ─────────────────────────────────────────────────────────────

/**
 * Returns the Supabase project URL.
 * Throws at call-time if the env var is absent so the route handler surfaces
 * a clear misconfiguration error rather than a cryptic network failure.
 */
export function supaUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  return url;
}

/**
 * Returns the canonical Supabase request headers.
 * Prefers the service-role key (server-side writes) and falls back to the
 * anon key (safe for read-only queries and local dev without service role).
 */
export function supaHeaders(): Record<string, string> {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

// ─── GET helper ───────────────────────────────────────────────────────────────

/**
 * Perform a GET request against the Supabase REST API.
 *
 * @param path  Path relative to the project URL (e.g. `/rest/v1/tokens?...`).
 * @param init  Optional overrides (currently only `timeout` in ms).
 * @returns     Parsed JSON body typed as `T`.
 * @throws      On network errors or non-2xx responses (logs details server-side).
 */
export async function supaGet<T>(
  path: string,
  init?: { timeout?: number },
): Promise<T> {
  const timeout = init?.timeout ?? 8000;
  const res = await fetch(`${supaUrl()}${path}`, {
    headers: supaHeaders(),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[supaGet] ${path} failed: ${res.status} ${body.slice(0, 200)}`);
    throw new Error(`supaGet ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/**
 * Read the `data` column of a single `tokens` row by provider name.
 *
 * @returns The typed `data` blob, or `null` if the row doesn't exist.
 * @throws  On network / HTTP errors.
 */
export async function supaGetTokenData<T>(provider: string): Promise<T | null> {
  const rows = await supaGet<TokenRow<T>[]>(
    `/rest/v1/tokens?provider=eq.${encodeURIComponent(provider)}&select=data`,
  );
  return rows?.[0]?.data ?? null;
}

/**
 * Upsert a row in the `tokens` table.
 * Uses `resolution=merge-duplicates` so existing rows are updated in-place.
 */
export async function supaUpsertToken<T>(
  provider: string,
  data: T,
): Promise<void> {
  const url = supaUrl();
  const res = await fetch(`${url}/rest/v1/tokens`, {
    method: 'POST',
    headers: {
      ...supaHeaders(),
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ provider, data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[supaUpsertToken] provider=${provider} failed: ${res.status} ${body.slice(0, 200)}`);
    throw new Error(`supaUpsertToken ${res.status}: ${provider}`);
  }
}

// ─── Insert helper ────────────────────────────────────────────────────────────

/**
 * Insert one or more rows into a Supabase table.
 * Never throws — logs on failure so callers can fire-and-forget with `.catch(() => {})`.
 */
export async function supaInsert<T>(table: string, rows: T[]): Promise<void> {
  const url = supaUrl();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supaHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[supaInsert] ${table} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
