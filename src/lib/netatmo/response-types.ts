/**
 * Typed response shapes for Netatmo API endpoints called by ThermoLeo.
 *
 * All types are derived from actual usage in client.ts and the API routes.
 * Reference: https://dev.netatmo.com/apidocumentation/control
 */

import type { NetatmoHome } from './client';

// ─── OAuth2 token response ─────────────────────────────────────────────────────

/**
 * Raw response body from `POST /oauth2/token`.
 * Parsed in `exchangeCode` and `refreshTokens` in client.ts.
 */
export interface NetatmoTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  /** Present on error responses instead of the token fields above. */
  error?: string;
}

// ─── /api/homesdata ───────────────────────────────────────────────────────────

/**
 * The `body` of a successful `GET /api/homesdata` response.
 * `getHomesData` in client.ts returns this shape directly.
 */
export interface HomesDataBody {
  homes: NetatmoHome[];
}

// ─── /api/homestatus ──────────────────────────────────────────────────────────

/**
 * The `body` of a successful `GET /api/homestatus` response.
 * `netatmoGet` strips the outer `{ status, time_server, body }` envelope and
 * returns `body` directly. The Netatmo API wraps the actual home under a
 * nested `home` key inside `body`.
 */
export interface HomeStatusBody {
  home: NetatmoHome;
}

// ─── /api/setstate ────────────────────────────────────────────────────────────

/**
 * Response from `POST /api/setstate`.
 * `netatmoPostJson` returns the full parsed JSON (including the outer envelope).
 * Netatmo returns `{ status: "ok", time_server: number }` on success.
 */
export interface SetStateResponse {
  status: string;
  time_server?: number;
  /** Present on error. */
  error?: { code: number; message: string } | string;
}

