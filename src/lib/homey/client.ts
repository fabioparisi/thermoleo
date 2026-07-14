/**
 * Homey OAuth2 client — Athom Cloud Web API.
 *
 * Authoritative source: https://api.developer.homey.app/
 *
 * IMPORTANT — non-standard OAuth2 parameter names (per Athom spec):
 *   - Authorize URL uses `authorization_type=code` (NOT `response_type=code`).
 *   - Token POST body uses `authorization_code=<code>` (NOT `code=<code>`).
 *   - Client credentials go in HTTP Basic auth (NOT body fields).
 *
 * Endpoints (all on api.athom.com):
 *   - GET  /oauth2/authorise — consent UI
 *   - POST /oauth2/token — exchange + refresh
 *   - GET  /user/me — current user, includes `homeys[]` array with localUrl
 *   - POST /delegation/token?audience=homey — get delegation JWT (TTL ~5min)
 *
 * Local Homey session flow:
 *   - POST <homeyUrl>/api/manager/users/login  body: {"token": "<delegation>"}
 *     → returns a JSON string (the session token). Use it as Bearer for all
 *       subsequent /api/manager/* calls on the local Homey.
 *   - Session token TTL is short (~10min) — re-mint on demand.
 *
 * Persistence: Supabase `tokens` row with provider='homey', mirrors Netatmo.
 */

const HOMEY_CLIENT_ID = process.env.HOMEY_CLIENT_ID!;
const HOMEY_CLIENT_SECRET = process.env.HOMEY_CLIENT_SECRET || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const TOKEN_URL = 'https://api.athom.com/oauth2/token';
const AUTHORIZE_URL = 'https://api.athom.com/oauth2/authorise';
const API_BASE = 'https://api.athom.com';
const PROVIDER = 'homey';

// ─── Token persistence ────────────────────────────────────────────────────────

interface HomeyTokenData {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_at: number; // epoch ms
  homey_id?: string | null;
  homey_url?: string | null;
}

function supaHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
}

async function loadStoredTokens(): Promise<HomeyTokenData | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tokens?provider=eq.${PROVIDER}&select=data`,
      { headers: supaHeaders(), signal: AbortSignal.timeout(5000) },
    );
    const rows = (await res.json()) as Array<{ data: HomeyTokenData }>;
    return rows?.[0]?.data ?? null;
  } catch {
    return null;
  }
}

async function saveTokens(data: HomeyTokenData): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tokens`, {
      method: 'POST',
      headers: { ...supaHeaders(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        provider: PROVIDER,
        data,
        updated_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error('[homey] saveTokens failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('[homey] saveTokens error:', e instanceof Error ? e.message : e);
  }
}

function basicAuthHeader(): string {
  const raw = `${HOMEY_CLIENT_ID}:${HOMEY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw, 'utf-8').toString('base64')}`;
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(redirectUri: string, state?: string): string {
  // Athom OAuth2 quirks (empirically verified 2026-05-25):
  //   - REQUIRES standard `response_type=code` (server rejects without it).
  //   - Token-exchange body still uses non-standard `authorization_code=<code>`
  //     field instead of `code=<code>` (see exchangeCodeForTokens).
  //   - Authorize host `api.athom.com` is canonical (accounts.athom.com 301s here).
  const params = new URLSearchParams({
    client_id: HOMEY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
  });
  if (state) params.set('state', state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
}

interface ExchangeResult {
  ok: boolean;
  data?: HomeyTokenData;
  error?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  if (!HOMEY_CLIENT_SECRET) {
    return { ok: false, error: 'HOMEY_CLIENT_SECRET missing on server' };
  }
  try {
    // Empirically verified 2026-05-25: Athom token endpoint requires the
    // standard `code` parameter (the docs erroneously mention `authorization_code`
    // — server returns `{"error":"invalid_request","error_description":"No \"code\" parameter"}`).
    // Client credentials in HTTP Basic Auth header.
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Athom ${res.status}: ${text.slice(0, 200)}` };
    }
    let parsed: TokenResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `Non-JSON response: ${text.slice(0, 200)}` };
    }
    if (!parsed.access_token || !parsed.refresh_token) {
      return { ok: false, error: `Missing tokens in response: ${text.slice(0, 200)}` };
    }
    const expiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000;
    const data: HomeyTokenData = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      token_type: parsed.token_type ?? 'bearer',
      expires_at: expiresAt,
    };
    // Discover Homey id/url via /user/me.
    try {
      const me = await getUserMe(parsed.access_token);
      const homey = me?.homeys?.[0];
      if (homey) {
        data.homey_id = homey._id ?? homey.id ?? null;
        data.homey_url = homey.localUrlSecure ?? homey.localUrl ?? homey.remoteUrl ?? null;
      }
    } catch (e) {
      console.warn('[homey] post-exchange /user/me failed:', e instanceof Error ? e.message : e);
    }
    await saveTokens(data);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}

export async function refreshAccessToken(): Promise<HomeyTokenData | null> {
  const current = await loadStoredTokens();
  if (!current?.refresh_token) return null;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error('[homey] refresh failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const parsed = (await res.json()) as TokenResponse;
    const next: HomeyTokenData = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token ?? current.refresh_token,
      token_type: parsed.token_type ?? 'bearer',
      expires_at: Date.now() + (parsed.expires_in ?? 3600) * 1000,
      homey_id: current.homey_id,
      homey_url: current.homey_url,
    };
    await saveTokens(next);
    return next;
  } catch (e) {
    console.error('[homey] refresh error:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getValidCloudToken(): Promise<string | null> {
  const t = await loadStoredTokens();
  if (!t) return null;
  if (Date.now() < t.expires_at - 60_000) return t.access_token;
  const refreshed = await refreshAccessToken();
  return refreshed?.access_token ?? null;
}

// ─── Athom Cloud user/homeys discovery ────────────────────────────────────────

export interface AthomHomey {
  _id?: string;
  id?: string;
  name?: string;
  localUrl?: string | null;
  localUrlSecure?: string | null;
  remoteUrl?: string | null;
}

interface AthomUserMe {
  _id?: string;
  id?: string;
  email?: string;
  homeys?: AthomHomey[];
}

export async function getUserMe(accessToken?: string): Promise<AthomUserMe | null> {
  const token = accessToken ?? (await getValidCloudToken());
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/user/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as AthomUserMe;
  } catch {
    return null;
  }
}

// ─── Delegation + local-Homey session ─────────────────────────────────────────

/**
 * Get a delegation JWT for `audience=homey`. Response is a JSON-encoded STRING.
 * TTL ~5 minutes; re-mint each time you need a fresh session.
 */
export async function getDelegationToken(): Promise<string | null> {
  const access = await getValidCloudToken();
  if (!access) return null;
  try {
    const res = await fetch(`${API_BASE}/delegation/token?audience=homey`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    // Response body is a JSON string like "eyJ..." (with quotes). JSON.parse returns the bare token.
    const text = await res.text();
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.replace(/^"|"$/g, '');
    }
  } catch {
    return null;
  }
}

/**
 * Exchange a delegation token for a Homey session token via the local API.
 * Response is also a JSON-encoded STRING.
 */
export async function getHomeySession(): Promise<{ token: string; url: string } | null> {
  const stored = await loadStoredTokens();
  const homeyUrl = stored?.homey_url;
  if (!homeyUrl) {
    console.warn('[homey] getHomeySession: no homey_url stored');
    return null;
  }
  const delegation = await getDelegationToken();
  if (!delegation) return null;
  try {
    const res = await fetch(`${homeyUrl.replace(/\/$/, '')}/api/manager/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: delegation }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error('[homey] session login failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const text = await res.text();
    let sessionToken: string;
    try {
      sessionToken = JSON.parse(text) as string;
    } catch {
      sessionToken = text.replace(/^"|"$/g, '');
    }
    return { token: sessionToken, url: homeyUrl };
  } catch (e) {
    console.error('[homey] getHomeySession error:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Convenience: authenticated GET against the local Homey using a fresh session token. */
export async function homeyGet<T = unknown>(path: string): Promise<T | null> {
  const sess = await getHomeySession();
  if (!sess) return null;
  try {
    const res = await fetch(`${sess.url.replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${sess.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── Health check used by the callback page ───────────────────────────────────

export async function checkHomeyHealth(): Promise<{
  ok: boolean;
  reason?: string;
  sensorCount?: number;
  homeyId?: string | null;
}> {
  const me = await getUserMe();
  if (!me) return { ok: false, reason: 'no_user_me' };
  const homey = me.homeys?.[0];
  if (!homey) return { ok: false, reason: 'no_homey_in_account' };
  return {
    ok: true,
    homeyId: homey._id ?? homey.id ?? null,
  };
}

/** Backward-compat shim. */
export async function seedHomeyTokens(): Promise<void> {
  // No-op
}

export interface SonoffReading {
  roomId: string;
  temperature: number;
  humidity: number;
  lastChanged?: string;
  stale?: boolean;
}
