/**
 * Lightweight auth helpers for ThermoLeo API routes.
 *
 * Threat model (2026-04-23): the dashboard has no user login yet. The
 * agent cycle endpoint is protected by AGENT_CRON_SECRET (Bearer token,
 * server-to-server only). Write endpoints invoked from the browser
 * (PATCH /api/rooms/[id], POST /api/sabiana/command, POST /api/settings,
 * POST /api/netatmo/setpoint) rely on a same-origin check instead: the
 * browser automatically attaches an `Origin` header on non-GET requests,
 * `curl` and random scanner bots do not. This is an interim measure
 * ahead of a proper password-cookie login planned for a follow-up.
 *
 * Policy decision recorded with user 2026-04-23: "Origin check ORA +
 * cookie password in futuro".
 */

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

const ALLOWED_ORIGINS = new Set<string>([
  'https://thermoleo-app.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function extraAllowedOrigin(): string | null {
  const extra = process.env.THERMOLEO_ALLOWED_ORIGIN;
  return extra ? extra.replace(/\/$/, '') : null;
}

/**
 * Verify a write request comes from the dashboard (same-origin) or from
 * an explicitly-allowed origin. Rejects cross-origin, missing-origin,
 * and unparseable-origin requests.
 *
 * Usage:
 *   const auth = assertWriteAuth(request);
 *   if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 403 });
 */
export function assertWriteAuth(request: Request): AuthResult {
  const origin = request.headers.get('origin');
  if (!origin) {
    // curl / scripts / server-to-server never set Origin. For public
    // writes this must be rejected. (Server-to-server callers should use
    // the Bearer token path, not write-origin.)
    return { ok: false, reason: 'missing_origin' };
  }
  const normalized = origin.replace(/\/$/, '');
  const extra = extraAllowedOrigin();
  if (ALLOWED_ORIGINS.has(normalized) || (extra && normalized === extra)) {
    return { ok: true };
  }
  return { ok: false, reason: 'origin_not_allowed' };
}

/**
 * Bearer-token check for server-to-server callers (cron, external triggers).
 * Fails CLOSED if the expected secret is not configured — prevents an
 * empty-env deploy from silently exposing a public endpoint.
 */
export function assertBearerSecret(request: Request, envVar: string): AuthResult {
  const expected = process.env[envVar];
  if (!expected) {
    // Explicit fail-closed. Do not fall back to "allow".
    return { ok: false, reason: `${envVar}_not_configured` };
  }
  const header = request.headers.get('authorization');
  if (header === `Bearer ${expected}`) return { ok: true };
  return { ok: false, reason: 'invalid_bearer' };
}
