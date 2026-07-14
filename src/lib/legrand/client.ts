/**
 * Works with Legrand API client (Smarther 2 setpoint writes).
 *
 * Docs: https://developer.legrand.com/tutorial/
 * OAuth2 endpoint: https://partners-login.eliotbylegrand.com/
 * API base:        https://api.developer.legrand.com/smarther/v2.0
 *
 * Required env vars (set after app is approved on developer.legrand.com):
 *   LEGRAND_CLIENT_ID          — from the "My Applications" details page
 *   LEGRAND_CLIENT_SECRET      — from the "My Applications" details page (CANNOT be recovered)
 *   LEGRAND_SUBSCRIPTION_KEY   — from the API > Subscriptions section ("Primary Key")
 *   LEGRAND_REDIRECT_URI       — must match exactly the one registered on the app
 *
 * Reference integration (HA): github.com/andrea-mattioli/bticino_x8000_component
 * Reply URL registered for this app: https://your-deployment.vercel.app/api/legrand/callback
 */

const AUTH_BASE = 'https://partners-login.eliotbylegrand.com';
const API_BASE = 'https://api.developer.legrand.com/smarther/v2.0';

const SCOPES = ['comfort.read', 'comfort.write'];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export interface LegrandTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  // Absolute expiry in epoch seconds (we compute and store this).
  expires_at?: number;
}

/**
 * Build the OAuth2 authorization URL for the user to visit.
 * After consent, the user lands on LEGRAND_REDIRECT_URI with ?code=… .
 */
export function buildAuthUrl(state: string): string {
  const clientId = requireEnv('LEGRAND_CLIENT_ID');
  const redirectUri = requireEnv('LEGRAND_REDIRECT_URI');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES.join(' '),
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for initial tokens.
 * Must be called from the callback route after user consent.
 */
export async function exchangeCode(code: string): Promise<LegrandTokens> {
  const clientId = requireEnv('LEGRAND_CLIENT_ID');
  const clientSecret = requireEnv('LEGRAND_CLIENT_SECRET');
  const redirectUri = requireEnv('LEGRAND_REDIRECT_URI');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Legrand token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as LegrandTokens;
  data.expires_at = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600) - 60;
  return data;
}

/**
 * Refresh an expired access token. The refresh_token itself rotates on
 * every call, so the caller MUST persist the new one returned here.
 */
export async function refreshTokens(refreshToken: string): Promise<LegrandTokens> {
  const clientId = requireEnv('LEGRAND_CLIENT_ID');
  const clientSecret = requireEnv('LEGRAND_CLIENT_SECRET');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Legrand refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as LegrandTokens;
  data.expires_at = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600) - 60;
  return data;
}

/**
 * Fetch the authenticated user's plant list.
 * GET /chronothermostat/thermoregulation/addressLocation/plants
 */
export async function getPlants(accessToken: string) {
  const subscriptionKey = requireEnv('LEGRAND_SUBSCRIPTION_KEY');
  const res = await fetch(
    `${API_BASE}/chronothermostat/thermoregulation/addressLocation/plants`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Legrand getPlants failed: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Fetch the status (including setpoint and measured temperature) of a
 * specific Smarther 2 module.
 * GET /chronothermostat/thermoregulation/addressLocation/plants/{plantId}/modules/parameter/id/value/{moduleId}
 */
export async function getModuleStatus(
  accessToken: string,
  plantId: string,
  moduleId: string,
) {
  const subscriptionKey = requireEnv('LEGRAND_SUBSCRIPTION_KEY');
  const url = `${API_BASE}/chronothermostat/thermoregulation/addressLocation/plants/${plantId}/modules/parameter/id/value/${moduleId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Legrand getModuleStatus failed: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Push a manual setpoint to the Smarther 2. Equivalent to tapping a
 * temperature on the BTicino Home+Control app.
 * POST same URL as getModuleStatus, with JSON body.
 *
 * Body shape (per andrea-mattioli/bticino_x8000_component):
 *   { "function": "heating", "mode": "manual",
 *     "setPoint": { "value": 22.0, "unit": "C" },
 *     "activationTime": "2026-04-23T19:30:00" }   // optional; if omitted
 *                                                 // setpoint sticks until
 *                                                 // manually cleared
 */
export async function setSetpoint(
  accessToken: string,
  plantId: string,
  moduleId: string,
  params: {
    temperature: number;
    /** 'heating' | 'cooling' — Smarther 2 is heating-only in most Italian installations */
    fn?: 'heating' | 'cooling';
    /** 'manual' | 'automatic' | 'off' | 'protection' */
    mode?: 'manual' | 'automatic' | 'off' | 'protection';
    /** ISO datetime when the override should end. Omit for "sticky" manual mode. */
    activationTime?: string;
  },
) {
  const subscriptionKey = requireEnv('LEGRAND_SUBSCRIPTION_KEY');
  const url = `${API_BASE}/chronothermostat/thermoregulation/addressLocation/plants/${plantId}/modules/parameter/id/value/${moduleId}`;

  const body: Record<string, unknown> = {
    function: params.fn ?? 'heating',
    mode: params.mode ?? 'manual',
    setPoint: { value: params.temperature, unit: 'C' },
  };
  if (params.activationTime) body.activationTime = params.activationTime;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Legrand setSetpoint failed: ${res.status} ${text}`);
  }
  // Legrand returns 204 No Content on success.
  return { ok: true, status: res.status };
}
