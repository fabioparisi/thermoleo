/**
 * MELCloud "Classic" API client for the campomarino Mitsubishi splits (ATA).
 *
 * Thin client over the HTTP surface documented in
 * `docs/melcloud-api-reference.md`. Read-only on the actuation side until a
 * campomarino room's `actuation_enabled` flag is set; `setAta` exists but the
 * cycle gates it.
 *
 * Auth: a single ContextKey (no refresh dance — re-login on 401). The key is
 * cached in-process for warm Lambda reuse and persisted to the `tokens` table
 * under provider `melcloud:campomarino` so a cold Lambda can reuse it without a
 * fresh login. Credentials come from env (MELCLOUD_EMAIL / MELCLOUD_PASSWORD),
 * never persisted.
 */

import { supaGetTokenData, supaUpsertToken } from '@/lib/supabase/rest';
import {
  MEL_MODE,
  MEL_FAN,
  MEL_FLAG,
  type MelContext,
  type MelDeviceState,
  type MelSetCommand,
} from './types';

const API_BASE = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
const APP_VERSION = '1.34.13.0';
const CONTEXT_PROVIDER = 'melcloud:campomarino';
const FETCH_TIMEOUT_MS = 15_000; // well under Vercel maxDuration=55s

let cachedContext: MelContext | null = null;

function credsFromEnv(): { email: string; password: string } {
  const email = process.env.MELCLOUD_EMAIL;
  const password = process.env.MELCLOUD_PASSWORD;
  if (!email || !password) {
    throw new Error('MELCLOUD_EMAIL and MELCLOUD_PASSWORD required');
  }
  return { email, password };
}

/** POST /Login/ClientLogin → ContextKey. Throws on failure. */
async function login(): Promise<MelContext> {
  const { email, password } = credsFromEnv();
  const res = await fetch(`${API_BASE}/Login/ClientLogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      Email: email,
      Password: password,
      Language: 0,
      AppVersion: APP_VERSION,
      Persist: true,
      CaptchaResponse: null,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MELCloud login HTTP ${res.status}`);
  const body = await res.json();
  const contextKey: string | undefined = body?.LoginData?.ContextKey;
  if (!contextKey) {
    const errId = body?.LoginData?.ErrorId ?? body?.ErrorId;
    throw new Error(`MELCloud login failed (ErrorId=${errId ?? 'unknown'})`);
  }
  const ctx: MelContext = { contextKey, obtainedAt: Date.now() };
  cachedContext = ctx;
  // Persist best-effort; a failed write just means the next cold Lambda re-logs.
  await supaUpsertToken(CONTEXT_PROVIDER, ctx).catch(() => {});
  return ctx;
}

/** Get a usable ContextKey: in-process cache → persisted row → fresh login. */
async function getContext(): Promise<MelContext> {
  if (cachedContext) return cachedContext;
  const persisted = await supaGetTokenData<MelContext>(CONTEXT_PROVIDER).catch(() => null);
  if (persisted?.contextKey) {
    cachedContext = persisted;
    return persisted;
  }
  return login();
}

/**
 * Authenticated fetch with one transparent re-login on 401. On 429, surfaces a
 * RateLimit-shaped error carrying retryAfterMs so the caller can back off.
 */
async function melFetch(
  path: string,
  init: RequestInit,
  retriedAuth = false,
): Promise<unknown> {
  const ctx = await getContext();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'X-MitsContextKey': ctx.contextKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 401 && !retriedAuth) {
    cachedContext = null;
    await login();
    return melFetch(path, init, true);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After'));
    const err = new Error('MELCloud rate-limited (429)') as Error & { retryAfterMs?: number };
    err.retryAfterMs = Number.isFinite(ra) ? ra * 1000 : 60_000;
    throw err;
  }
  if (!res.ok) throw new Error(`MELCloud ${path} HTTP ${res.status}`);
  return res.json();
}

// ─── ListDevices (nested tree → flat ATA list) ──────────────────────────────────

interface RawDevice {
  DeviceID: number;
  DeviceName?: string;
  BuildingID?: number;
  Device?: Record<string, unknown>;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function normalize(raw: RawDevice, buildingId: number): MelDeviceState {
  const d = raw.Device ?? {};
  return {
    deviceId: raw.DeviceID,
    buildingId: raw.BuildingID ?? buildingId,
    name: raw.DeviceName ?? String(raw.DeviceID),
    roomTemperature: num(d.RoomTemperature),
    setTemperature: num(d.SetTemperature),
    operationMode: num(d.OperationMode),
    power: bool(d.Power),
    fanSpeed: num(d.SetFanSpeed),
    outdoorTemperature: num(d.OutdoorTemperature),
    minTempCoolDry: num(d.MinTempCoolDry),
    maxTempCoolDry: num(d.MaxTempCoolDry),
    minTempHeat: num(d.MinTempHeat),
    maxTempHeat: num(d.MaxTempHeat),
    minTempAuto: num(d.MinTempAutomatic),
    maxTempAuto: num(d.MaxTempAutomatic),
  };
}

/**
 * GET /User/ListDevices → all ATA devices flattened across the nested
 * building/floor/area structure (devices can live at any of 4 depths).
 */
export async function listDevices(): Promise<MelDeviceState[]> {
  const buildings = (await melFetch('/User/ListDevices', { method: 'GET' })) as Array<{
    ID?: number;
    Structure?: {
      Devices?: RawDevice[];
      Floors?: Array<{ Devices?: RawDevice[]; Areas?: Array<{ Devices?: RawDevice[] }> }>;
      Areas?: Array<{ Devices?: RawDevice[] }>;
    };
  }>;
  const out: MelDeviceState[] = [];
  for (const b of buildings ?? []) {
    const bid = b.ID ?? 0;
    const s = b.Structure ?? {};
    const collect = (arr?: RawDevice[]) => {
      for (const raw of arr ?? []) out.push(normalize(raw, bid));
    };
    collect(s.Devices);
    for (const f of s.Floors ?? []) {
      collect(f.Devices);
      for (const a of f.Areas ?? []) collect(a.Devices);
    }
    for (const a of s.Areas ?? []) collect(a.Devices);
  }
  return out;
}

/** GET /Device/Get → one device's current state. */
export async function getDevice(deviceId: number, buildingId: number): Promise<MelDeviceState> {
  const raw = (await melFetch(
    `/Device/Get?id=${deviceId}&buildingID=${buildingId}`,
    { method: 'GET' },
  )) as Record<string, unknown>;
  return normalize({ DeviceID: deviceId, BuildingID: buildingId, Device: raw }, buildingId);
}

// ─── SetAta (actuation — gated by the caller) ───────────────────────────────────

function clamp(v: number, min: number | null, max: number | null): number {
  if (min !== null && v < min) return min;
  if (max !== null && v > max) return max;
  return v;
}

function resolveFan(fan: MelSetCommand['fan']): number {
  if (fan === 'auto' || fan === undefined) return MEL_FAN.auto;
  if (fan === 'silent') return MEL_FAN.silent;
  // numeric abstract level 1..5 maps onto the same MELCloud values
  return clamp(Math.round(fan), 1, 5);
}

/**
 * Build the /Device/SetAta payload (pure — no network).
 *
 * EffectiveFlags is the OR of the bits for every field actually being changed;
 * a field whose bit is NOT set is silently ignored by MELCloud, so a wrong bit
 * = a silent no-op command (e.g. a heat command that never reaches Nursery's
 * room). SetTemperature is clamped to the device's per-mode range. `mode:'off'`
 * sends Power=false and sets no mode/temp/fan. Exported for unit testing the
 * bitmask + clamp without hitting the cloud.
 */
export function buildSetAtaPayload(
  deviceId: number,
  cmd: MelSetCommand,
  dev?: MelDeviceState,
): Record<string, unknown> {
  let flags = 0;
  const payload: Record<string, unknown> = {
    DeviceID: deviceId,
    HasPendingCommand: true,
  };

  // Power
  payload.Power = cmd.mode !== 'off' && cmd.power;
  flags |= MEL_FLAG.Power;

  // Operation mode (skip when turning off — Power handles it)
  if (cmd.mode !== 'off') {
    payload.OperationMode = MEL_MODE[cmd.mode];
    flags |= MEL_FLAG.OperationMode;
  }

  // Set temperature with per-mode clamp
  if (cmd.temperature !== undefined && cmd.mode !== 'off' && cmd.mode !== 'fan') {
    let min: number | null = null;
    let max: number | null = null;
    if (dev) {
      if (cmd.mode === 'cool' || cmd.mode === 'dry') {
        min = dev.minTempCoolDry; max = dev.maxTempCoolDry;
      } else if (cmd.mode === 'heat') {
        min = dev.minTempHeat; max = dev.maxTempHeat;
      } else {
        min = dev.minTempAuto; max = dev.maxTempAuto;
      }
    }
    payload.SetTemperature = clamp(cmd.temperature, min, max);
    flags |= MEL_FLAG.SetTemperature;
  }

  // Fan
  if (cmd.fan !== undefined && cmd.mode !== 'off') {
    payload.SetFanSpeed = resolveFan(cmd.fan);
    flags |= MEL_FLAG.SetFanSpeed;
  }

  // Vertical vane: per-room (cmd.vaneVertical), defaulting to UPWARDS (position 1),
  // never swing. With a baby in the room, cold air aimed high distributes gently by
  // convection instead of basculating onto the crib (Fabio 2026-06-21) — so Nursery's
  // rooms stay at 1. A non-baby room (soggiorno) can blow DOWNWARDS (5) when the
  // agent asks for it (Fabio 2026-06-30). Set on every power-on.
  if (cmd.mode !== 'off') {
    payload.VaneVertical = cmd.vaneVertical ?? 1; // ClassicVertical: 1=upwards, 5=downwards (7=swing — avoided)
    flags |= MEL_FLAG.VaneVertical;
  }

  payload.EffectiveFlags = flags;
  return payload;
}

/**
 * POST /Device/SetAta — set power/mode/temp/fan on one ATA unit.
 * Read the device's current state and pass its bounds in `dev` so the clamp
 * uses real per-mode limits; without `dev`, temperature is sent unclamped.
 */
export async function setAta(
  deviceId: number,
  buildingId: number,
  cmd: MelSetCommand,
  dev?: MelDeviceState,
): Promise<void> {
  await melFetch('/Device/SetAta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(buildSetAtaPayload(deviceId, cmd, dev)),
  });
}
