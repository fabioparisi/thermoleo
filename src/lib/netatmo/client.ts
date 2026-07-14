/**
 * Netatmo API client for BTicino Home+Control devices.
 * Handles OAuth2 token management, home status, and thermostat control.
 */

const NETATMO_BASE = 'https://api.netatmo.com';
const TOKEN_URL = `${NETATMO_BASE}/oauth2/token`;

export interface NetatmoTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix timestamp in ms
  scope: string;
}

export interface NetatmoRoom {
  id: string;
  name: string;
  type: string;
  therm_measured_temperature?: number;
  therm_setpoint_temperature?: number;
  therm_setpoint_mode?: string; // 'manual' | 'schedule' | 'away' | 'hg'
  heating_power_request?: number;
}

export interface NetatmoModule {
  id: string;
  type: string;
  name: string;
  setup_date: number;
  battery_state?: string; // 'full' | 'high' | 'medium' | 'low' | 'very_low'
  battery_level?: number;
  reachable?: boolean;
  rf_strength?: number;
  firmware_revision?: number;
}

export interface NetatmoHome {
  id: string;
  name: string;
  rooms: NetatmoRoom[];
  modules: NetatmoModule[];
}

// --- Token exchange ---

export async function exchangeCode(code: string): Promise<NetatmoTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.NETATMO_CLIENT_ID!,
      client_secret: process.env.NETATMO_CLIENT_SECRET!,
      code,
      redirect_uri: process.env.NETATMO_REDIRECT_URI!,
      scope: 'read_smarther write_smarther read_thermostat write_thermostat',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Netatmo token exchange failed: ${data.error}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

export async function refreshTokens(refreshToken: string): Promise<NetatmoTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.NETATMO_CLIENT_ID!,
      client_secret: process.env.NETATMO_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Netatmo token refresh failed: ${data.error}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

// --- API calls ---

async function netatmoGet(accessToken: string, endpoint: string, params?: Record<string, string>) {
  const url = new URL(`${NETATMO_BASE}${endpoint}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Netatmo API error: ${data.error.message || data.error}`);
  return data.body;
}

async function netatmoPostJson(accessToken: string, endpoint: string, body: unknown) {
  const res = await fetch(`${NETATMO_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Netatmo API error: ${data.error.message || data.error}`);
  return data;
}

/**
 * Get home topology — rooms, modules, schedules.
 */
export async function getHomesData(accessToken: string): Promise<{ homes: NetatmoHome[] }> {
  return netatmoGet(accessToken, '/api/homesdata');
}

/**
 * Get current status of all rooms and modules in a home.
 */
export async function getHomeStatus(accessToken: string, homeId: string): Promise<NetatmoHome> {
  const body = await netatmoGet(accessToken, '/api/homestatus', { home_id: homeId });
  if (!body?.home) {
    return { id: homeId, name: '', rooms: [], modules: [] };
  }
  return body.home;
}

/**
 * Set a room's setpoint on a Netatmo Home+Control (BNS) installation.
 *
 * This endpoint works for BTicino Smarther 2 AND for Netatmo valves attached
 * to a Smarther-based home. The older `/api/setroomthermpoint` (Energy API)
 * only accepts ThermRelay-class devices (NATherm1 + NRV) and rejects
 * Smarther-family devices with "The device is not a ThermRelay".
 *
 * Confirmed working on 2026-04-23 against this house via:
 *   POST /api/setstate  { home: { id, rooms: [{id, therm_setpoint_mode,
 *                                               therm_setpoint_temperature,
 *                                               therm_setpoint_end_time}] } }
 *
 * Scope required: `write_smarther` (already in our OAuth scope list).
 *
 * @param mode 'home' restores schedule, 'manual' sets explicit temp, 'max' boosts, 'hg' frost-guard.
 * @param temp target temperature in °C (required only for 'manual').
 * @param endTimeEpochSec unix seconds when the manual override expires.
 *        Omit (or 0) for "until next schedule change". 2147483646 = effectively forever.
 *
 * Docs:
 *  - https://dev.netatmo.com/apidocumentation/control#setstate
 *  - pyatmo const.py SETSTATE_ENDPOINT (BNS/Smarther path)
 *  - smarther2mqtt production reference implementation
 */
export async function setRoomState(
  accessToken: string,
  homeId: string,
  roomId: string,
  mode: 'home' | 'manual' | 'max' | 'hg',
  temp?: number,
  endTimeEpochSec?: number,
) {
  const roomPayload: Record<string, unknown> = {
    id: roomId,
    therm_setpoint_mode: mode,
  };
  if (mode === 'manual') {
    if (temp === undefined) throw new Error('setRoomState manual mode requires temp');
    roomPayload.therm_setpoint_temperature = temp;
    if (endTimeEpochSec !== undefined) {
      roomPayload.therm_setpoint_end_time = endTimeEpochSec;
    }
  }
  return netatmoPostJson(accessToken, '/api/setstate', {
    home: { id: homeId, rooms: [roomPayload] },
  });
}

/**
 * Cooling-mode counterpart of setRoomState.
 *
 * When the home's `temperature_control_mode === 'cooling'`, each room exposes
 * a separate `cooling_setpoint_*` triple distinct from the heating one. Writes
 * to `therm_setpoint_temperature` are still accepted but reflect the HEATING
 * setpoint, which is meaningless while the firmware is in cooling mode — the
 * valve obeys the cooling setpoint, and setting a heating value while in cool
 * does nothing visible.
 *
 * In cooling mode the firmware logic INVERTS:
 *   measured > cooling_setpoint → valve OPEN (room too hot, ask for cold water)
 *   measured ≤ cooling_setpoint → valve CLOSED (room already cool enough)
 *
 * So to keep the apartment-level zone valve permanently OPEN in summer (so the
 * cold-water riser flows to every fancoil regardless of where the Smarther
 * thermostat sits), push a manual cooling_setpoint BELOW any realistic indoor
 * temperature — e.g. 16°C. The Smarther will perpetually "ask for more
 * cooling", valve stays open, fancoils handle per-room throttling downstream.
 *
 * Confirmed working 2026-05-26 live against this house — see
 * docs/smarther-cool-mode.md.
 */
export async function setRoomCoolingState(
  accessToken: string,
  homeId: string,
  roomId: string,
  mode: 'home' | 'manual',
  temp?: number,
  endTimeEpochSec?: number,
) {
  const roomPayload: Record<string, unknown> = {
    id: roomId,
    cooling_setpoint_mode: mode,
  };
  if (mode === 'manual') {
    if (temp === undefined) throw new Error('setRoomCoolingState manual mode requires temp');
    roomPayload.cooling_setpoint_temperature = temp;
    if (endTimeEpochSec !== undefined) {
      roomPayload.cooling_setpoint_end_time = endTimeEpochSec;
    }
  }
  return netatmoPostJson(accessToken, '/api/setstate', {
    home: { id: homeId, rooms: [roomPayload] },
  });
}

/**
 * Build OAuth authorization URL for the user to visit.
 */
export function getAuthUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: process.env.NETATMO_CLIENT_ID!,
    redirect_uri: process.env.NETATMO_REDIRECT_URI!,
    scope: 'read_smarther write_smarther read_thermostat write_thermostat',
    state: state || 'thermoleo',
  });
  return `${NETATMO_BASE}/oauth2/authorize?${params}`;
}
