import type {
  SabianaAuthTokens,
  SabianaCommand,
  SabianaDevice,
  SabianaDeviceState,
  SabianaJWT,
  SabianaMode,
} from './types';

const BASE_URL = 'https://be-standard.sabianawm.cloud';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 11; IN2013) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.82 Mobile Safari/537.36';

function createHeaders(shortJwt?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Host': 'be-standard.sabianawm.cloud',
    'content-type': 'application/json',
    'accept': 'application/json, text/plain, */*',
    'origin': 'capacitor://sabianawm.cloud',
    'user-agent': USER_AGENT,
  };
  if (shortJwt) headers['auth'] = shortJwt;
  return headers;
}

function extractJwtExpiry(token: string): Date {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  let payload = parts[1];
  // Fix base64url padding
  payload += '='.repeat((4 - (payload.length % 4)) % 4);
  const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  if (!decoded.exp) throw new Error('JWT missing exp claim');
  return new Date(decoded.exp * 1000);
}

function createJwt(token: string): SabianaJWT {
  return { token, expiresAt: extractJwtExpiry(token) };
}

// ---- lastData decoder ----

const MODE_MAP: Record<number, SabianaMode> = {
  0: 'cool',
  1: 'heat',
  3: 'fan_only',
  4: 'off',
};

/**
 * Decode the Sabiana `lastData` hex blob.
 *
 * Byte layout reverse-engineered against the official edoeel/homeassistant-sabiana-hvac
 * integration (https://github.com/edoeel/homeassistant-sabiana-hvac) — see
 * `custom_components/sabiana_hvac/const.py` and `api.py decode_last_data()`.
 *
 *   byte[5]    HVAC mode raw (0=cool, 1=heat, 2=auto, 3=fan_only, 4=off)
 *   byte[7]    upper nibble = fan command echoed back:
 *                0x0 = Low, 0x1 = Medium, 0x2 = Auto, 0x3 = High
 *   byte[8]    flap position 0-4 (255 = invalid/uninitialised on tmb)
 *   byte[10-11] T1 ambient temperature (big-endian, /10 °C)
 *   byte[12-13] COOL/Summer setpoint
 *   byte[14-15] HEAT/Winter setpoint
 *   byte[16-17] AUTO setpoint
 *
 * The active setpoint to return depends on the current mode. We don't have
 * separate T2 (supply-air) or T3 (water) readings — those existed only in the
 * pre-edoeel reverse-engineering attempt and were actually the heat/auto
 * setpoint Modbus registers being mis-labelled. Any code that relied on
 * `supplyTemp` / `waterTemp` was reading meaningless numbers; both fields
 * are gone now.
 */
export function decodeLastData(hex: string): {
  temperature: number;
  setpoint: number;
  setpointCool: number;
  setpointHeat: number;
  setpointAuto: number;
  fanSpeed: number;
  fanSpeedRaw: number;
  flapPosition: number;
  mode: SabianaMode;
  /** True when the fan is actively moving air (byte[7] upper nibble 0-3).
   *  A reliable ON signal; its negation is NOT a reliable OFF signal. */
  fanRunning: boolean;
  /** The thermal mode byte[5] reports — heat/cool/auto. Used together with
   *  season + last command by api/rooms to decide the ON/OFF toggle. */
  storedMode: SabianaMode;
} {
  const matches = hex.match(/.{2}/g);
  if (!matches || matches.length < 18) {
    return {
      temperature: 0, setpoint: 0,
      setpointCool: 0, setpointHeat: 0, setpointAuto: 0,
      fanSpeed: 0, fanSpeedRaw: 0, flapPosition: 0,
      mode: 'off' as SabianaMode,
      fanRunning: false, storedMode: 'off' as SabianaMode,
    };
  }
  const bytes = new Uint8Array(matches.map((b) => parseInt(b, 16)));

  const t1 = ((bytes[10] << 8) | bytes[11]) / 10;
  const spCool = ((bytes[12] << 8) | bytes[13]) / 10;
  const spHeat = ((bytes[14] << 8) | bytes[15]) / 10;
  const spAuto = ((bytes[16] << 8) | bytes[17]) / 10;
  const modeRaw = bytes[5] & 0x0f;
  // byte[5] is the *remembered* thermal mode (which mode the unit runs/resumes
  // in). On an OFF command the firmware stops the fan but leaves byte[5] on the
  // last thermal mode (heat/cool) — it rarely if ever emits 0x04. So byte[5]
  // alone can't tell ON from OFF; the caller (api/rooms) combines it with the
  // fan state, the season, and the last user command to decide the toggle.
  const storedMode = MODE_MAP[modeRaw] ?? 'off';
  // Fan: upper nibble of byte 7. Valid running speeds are 0-3
  // (0=Low,1=Med,2=Auto,3=High per edoeel mapping). A value ABOVE 3 (observed
  // 0x6, stable 15+ min after an OFF command) means the fan is idle.
  //
  // IMPORTANT: fan-idle is NOT the same as "unit off". Verified live
  // 2026-06-17: a fancoil left ON in cool with the room already at/below
  // setpoint keeps its fan-nibble at a valid 0-3 — it does NOT drop to 0x6.
  // Only an explicit OFF command parks the nibble at 0x6. So "fan running"
  // (nibble 0-3) is a reliable ON signal, but "fan idle" is NOT a reliable
  // OFF signal — it could be a transient between an ON command and the device
  // echoing it back. The decoder therefore exposes the raw facts (storedMode,
  // fanRunning) and leaves the ON/OFF verdict to api/rooms, which has the
  // season + last-command context.
  const fanRawCommand = (bytes[7] >> 4) & 0x0f;
  const fanSpeedRaw = bytes[7];
  const fanRunning = fanRawCommand <= 3;
  // mode = the device's reported thermal mode. NOT forced to 'off' from the
  // fan nibble anymore (that caused on-but-at-target units to read as off).
  // Explicit off (byte[5]==0x04) is still honoured if the firmware ever emits it.
  const mode: SabianaMode = storedMode;
  // edoeel command-side mapping (FAN_MODE_MAP inverted):
  //   0 = Low (1), 1 = Medium (2), 3 = High (3), 2 = Auto (4)
  const fanSpeed =
    fanRawCommand === 0 ? 1 :
    fanRawCommand === 1 ? 2 :
    fanRawCommand === 3 ? 3 :
    fanRawCommand === 2 ? 4 :
    0; // idle (fan-nibble > 3, e.g. 0x6) — unit not currently moving air
  // Active setpoint depends on the remembered thermal mode.
  const sp = storedMode === 'cool' ? spCool : storedMode === 'heat' ? spHeat : spAuto;
  const flapPosition = bytes[8];

  return {
    temperature: t1,
    setpoint: sp,
    setpointCool: spCool,
    setpointHeat: spHeat,
    setpointAuto: spAuto,
    fanSpeed,
    fanSpeedRaw,
    flapPosition,
    mode,
    fanRunning,
    storedMode,
  };
}

// ---- API methods ----

const SABIANA_TIMEOUT_MS = 15000;

async function apiRequest(url: string, options: RequestInit): Promise<Record<string, unknown>> {
  // Always attach a timeout so a stalled Sabiana cloud doesn't push the
  // 10-min agent cycle past Vercel's 55s maxDuration. Sabiana sometimes
  // takes 5-10s on cold paths but never minutes; 15s is generous.
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(SABIANA_TIMEOUT_MS) });
  if (res.status === 401) throw new Error('SABIANA_AUTH_ERROR');
  if (!res.ok) throw new Error(`Sabiana API error: ${res.status}`);
  const data = await res.json();
  if (data.status !== 0) {
    if (data.status === 99 || data.status === 103) throw new Error('SABIANA_AUTH_ERROR');
    throw new Error(data.errorMessage || `Sabiana API status: ${data.status}`);
  }
  return data;
}

export async function authenticate(email: string, password: string): Promise<SabianaAuthTokens> {
  const data = await apiRequest(`${BASE_URL}/users/newLogin`, {
    method: 'POST',
    headers: createHeaders(),
    body: JSON.stringify({ email, password, device: 'ios' }),
  });
  const body = data.body as Record<string, unknown>;
  const user = body.user as Record<string, string>;
  return {
    shortJwt: createJwt(user.shortJwt),
    longJwt: createJwt(user.longJwt),
  };
}

export async function renewToken(longJwt: string): Promise<SabianaJWT> {
  const headers = createHeaders();
  delete headers['auth'];
  headers['renewauth'] = longJwt;
  const data = await apiRequest(`${BASE_URL}/renewJwt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const body = data.body as Record<string, unknown>;
  return createJwt(body.newToken as string);
}

export async function getDevices(shortJwt: string): Promise<SabianaDevice[]> {
  const data = await apiRequest(`${BASE_URL}/devices/getDeviceForUserV2`, {
    method: 'GET',
    headers: createHeaders(shortJwt),
  });
  const body = data.body as Record<string, unknown>;
  const devices = body.devices as Record<string, unknown>[];
  return devices.map((d) => ({
    id: d.idDevice as string,
    name: d.deviceName as string,
    connectionUp: d.connectionUp as boolean,
    modelType: (d.deviceStateModelType as string) || 'evo',
    wifiRSSI: (d.deviceWiFiRSSI as number) || 0,
    firmwareVersion: (d.deviceStateFw as string) || '',
    lastData: (d.lastData as string) || '',
  }));
}

export async function getDeviceStates(shortJwt: string): Promise<SabianaDeviceState[]> {
  const devices = await getDevices(shortJwt);
  return devices.map((d) => {
    const state = decodeLastData(d.lastData);
    return {
      deviceId: d.id,
      deviceName: d.name,
      connectionUp: d.connectionUp,
      modelType: d.modelType,
      ...state,
    };
  });
}

// ---- Command encoding ----

const MODE_CMD_MAP: Record<SabianaMode, string> = {
  cool: '0',
  heat: '1',
  fan_only: '3',
  off: '4',
};

function tempToHex(celsius: number): string {
  // Last line of defence: a NaN/Infinity here would emit "0NaN" into the
  // command blob and send malformed bytes to the cloud. Refuse it loudly so a
  // poisoned setpoint can never reach the hardware silently.
  if (!Number.isFinite(celsius)) {
    throw new Error(`tempToHex: non-finite temperature ${celsius}`);
  }
  return Math.round(celsius * 10).toString(16).padStart(4, '0');
}

export function buildCommand(cmd: SabianaCommand): string {
  const fan = cmd.fan.toString();
  const mode = MODE_CMD_MAP[cmd.mode];
  const temp = tempToHex(cmd.temperature);
  const swing = cmd.swing.toString();
  const preset = cmd.preset.toString();
  return `0${fan}0${mode}${temp}0${swing}01FFFF000${preset}`;
}

export async function sendCommand(
  shortJwt: string,
  deviceId: string,
  cmd: SabianaCommand,
): Promise<boolean> {
  const commandData = buildCommand(cmd);
  const data = await apiRequest(`${BASE_URL}/devices/cmd`, {
    method: 'POST',
    headers: createHeaders(shortJwt),
    body: JSON.stringify({ deviceID: deviceId, start: 2304, data: commandData, restart: false }),
  });
  const body = data.body as Record<string, unknown>;
  return (body.result as boolean) ?? false;
}
