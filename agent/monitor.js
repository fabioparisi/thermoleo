#!/usr/bin/env node

/**
 * ThermoLeo Intelligent Temperature Controller
 *
 * Actively controls ALL rooms to reach and maintain target temperatures.
 * Uses PID-inspired logic with anti-oscillation, stability scoring,
 * and priority-based control (Nursery = critical, priority 1).
 *
 * Success metric: time to reach target + stability (low variance) over time.
 */

const POLL_NORMAL_MS = 10 * 60 * 1000; // 10 minutes when stable
const POLL_ACTIVE_MS = 2 * 60 * 1000;  // 2 minutes when correcting
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between same alerts
const HISTORY_WINDOW = 6; // readings for stability scoring
const MIN_CYCLES_BETWEEN_CHANGES = 2; // minimum cycles between command changes
const MAX_COMMANDS_PER_HOUR = 6; // rate limit per room (higher for faster polling)

// --- Config from env ---
const SABIANA_EMAIL = process.env.SABIANA_EMAIL;
const SABIANA_PASSWORD = process.env.SABIANA_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const IMESSAGE_PROXY_URL = process.env.IMESSAGE_PROXY_URL || 'http://localhost:9100';
const IMESSAGE_RECIPIENT = process.env.IMESSAGE_RECIPIENT || 'fabioparisi@me.com';

// --- Sabiana API ---
const SABIANA_BASE = 'https://be-standard.sabianawm.cloud';
const SABIANA_UA = 'Mozilla/5.0 (Linux; Android 11; IN2013) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.82 Mobile Safari/537.36';

let sabianaTokens = null;

function sabianaHeaders(shortJwt) {
  return {
    'Host': 'be-standard.sabianawm.cloud',
    'content-type': 'application/json',
    'accept': 'application/json, text/plain, */*',
    'origin': 'capacitor://sabianawm.cloud',
    'user-agent': SABIANA_UA,
    ...(shortJwt ? { 'auth': shortJwt } : {}),
  };
}

function decodeJwtExp(token) {
  const parts = token.split('.');
  let payload = parts[1];
  payload += '='.repeat((4 - (payload.length % 4)) % 4);
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return new Date(decoded.exp * 1000);
}

async function sabianaAuth() {
  const res = await fetch(`${SABIANA_BASE}/users/newLogin`, {
    method: 'POST',
    headers: sabianaHeaders(),
    body: JSON.stringify({ email: SABIANA_EMAIL, password: SABIANA_PASSWORD, device: 'ios' }),
  });
  const data = await res.json();
  if (data.status !== 0) throw new Error(`Sabiana auth failed: ${data.errorMessage || data.status}`);
  const user = data.body.user;
  sabianaTokens = {
    short: { token: user.shortJwt, exp: decodeJwtExp(user.shortJwt) },
    long: { token: user.longJwt, exp: decodeJwtExp(user.longJwt) },
  };
  log('Sabiana authenticated');
}

async function sabianaRenew() {
  const headers = sabianaHeaders();
  headers['renewauth'] = sabianaTokens.long.token;
  const res = await fetch(`${SABIANA_BASE}/renewJwt`, {
    method: 'POST', headers, body: JSON.stringify({}),
  });
  const data = await res.json();
  if (data.status !== 0) throw new Error('JWT renewal failed');
  const newToken = data.body.newToken;
  sabianaTokens.short = { token: newToken, exp: decodeJwtExp(newToken) };
}

async function getValidToken() {
  const now = Date.now();
  const margin = 5 * 60 * 1000;
  if (!sabianaTokens) { await sabianaAuth(); return sabianaTokens.short.token; }
  if (now < sabianaTokens.short.exp.getTime() - margin) return sabianaTokens.short.token;
  if (now < sabianaTokens.long.exp.getTime() - margin) {
    try { await sabianaRenew(); return sabianaTokens.short.token; } catch { /* fall through */ }
  }
  await sabianaAuth();
  return sabianaTokens.short.token;
}

/**
 * Map raw ECM motor speed/voltage value (byte[4]) to fan command level 1-4.
 *
 * The device reports actual motor speed (ECM voltage * 10 or duty %),
 * NOT the commanded 1-4 level. Observed correlations from live data:
 *   raw ~4    → Auto/idle (fan barely running)
 *   raw ~20   → Low speed (fan=1 / Min)
 *   raw ~60   → Medium speed (fan=2 / Med)
 *   raw ~110  → High speed (fan=3 / Max)
 *
 * Returns values matching the command format: 1=Min, 2=Med, 3=Max, 4=Auto.
 * Thresholds derived from Sabiana Modbus ECM voltage ranges:
 *   SLu1 (MIN): 1.0-6.0V (10-60), SCu2 (MED): 3.0-8.0V (30-80),
 *   SHu3 (MAX): 6.0-10.0V (60-100+)
 */
function rawFanToLevel(raw) {
  if (raw <= 10) return 4;  // Auto / idle (very low or no speed)
  if (raw <= 40) return 1;  // Low (Min)
  if (raw <= 80) return 2;  // Medium (Med)
  return 3;                 // High (Max)
}

function decodeLastData(hex) {
  const bytes = hex.match(/.{2}/g).map(b => parseInt(b, 16));
  const fanSpeedRaw = bytes[4];
  return {
    temperature: ((bytes[10] << 8) | bytes[11]) / 10,
    setpoint: ((bytes[12] << 8) | bytes[13]) / 10,
    supplyTemp: ((bytes[14] << 8) | bytes[15]) / 10,
    waterTemp: ((bytes[16] << 8) | bytes[17]) / 10,
    mode: { 0: 'cool', 1: 'heat', 3: 'fan_only', 4: 'off' }[bytes[5] & 0x0f] || 'off',
    fanSpeed: rawFanToLevel(fanSpeedRaw),
    fanSpeedRaw,
  };
}

async function pollSabiana() {
  const token = await getValidToken();
  const res = await fetch(`${SABIANA_BASE}/devices/getDeviceForUserV2`, {
    headers: sabianaHeaders(token),
  });
  const data = await res.json();
  if (data.status !== 0) throw new Error(`Sabiana poll failed: ${data.status}`);
  return data.body.devices.map(d => ({
    deviceId: d.idDevice,
    deviceName: d.deviceName,
    connectionUp: d.connectionUp,
    ...decodeLastData(d.lastData || ''),
  }));
}

// --- Supabase ---
async function supabaseInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    log(`Supabase insert error (${table}): ${res.status} ${text}`, 'error');
  }
}

// --- Room mapping and targets ---
const DEVICE_TO_ROOM = {
  'swm-5443B26CD582': 'leone',
  'swm-24DCC3FCF49E': 'soggiorno',
  'swm-0C8B953686CE': 'camera',
  'swm-3CE90EA38D06': 'studio',
  'swm-3CE90EA00D82': 'cucina',
};

const ROOM_CONFIG = {
  leone:     { targetMin: 23, targetMax: 24, critical: true,  priority: 1 },   // target 23.5°C
  soggiorno: { targetMin: 22.5, targetMax: 23.5, critical: false, priority: 2 }, // target 23°C
  camera:    { targetMin: 21.5, targetMax: 22.5, critical: false, priority: 2 }, // target 22°C — ALWAYS OFF
  studio:    { targetMin: 22.5, targetMax: 23.5, critical: false, priority: 2 }, // target 23°C
  cucina:    { targetMin: 22.5, targetMax: 23.5, critical: false, priority: 3 }, // target 23°C
};

// Room overrides: user-explicit exceptions to normal control logic
const ROOM_OVERRIDES = {
  camera: { alwaysOff: true }, // Camera da letto: keep OFF always (user request)
};

// Derived: absolute safety bounds (±2°C from target range)
const SAFETY_BOUNDS = {
  leone:     { min: 21, max: 26 },
  soggiorno: { min: 20.5, max: 25.5 },
  camera:    { min: 19.5, max: 24.5 },
  studio:    { min: 20.5, max: 25.5 },
  cucina:    { min: 20.5, max: 25.5 },
};

// --- Homey / Sonoff SNZB-02D (accurate temperature source) ---
const HOMEY_IP = process.env.HOMEY_LOCAL_IP || '192.168.1.69';
const HOMEY_ID = '657d935f54a03dc2052f49d5';
const HOMEY_CLIENT_ID = '598d85a330e1bb0c0d75b8eb';

const HOMEY_DEVICE_MAP = {
  'ebb107ea-b611-4ba8-8cc1-09b9bec83391': 'leone',
  '390ece4c-5f4e-4c95-a916-fb6d64756781': 'studio',
  '56fb4006-df26-40a0-9a4b-66fae02b5264': 'camera',
  'd6eb5d58-9585-454b-9e92-41494bc6c4b1': 'bagno1',
  '9f4dfbc2-876c-4c06-b30c-092698286e2f': 'bagno2',
  'aaefa42a-c0cf-41cc-b14f-b6dea639e311': 'cucina',
  'a6304d59-5175-4b9b-ba33-aaba6a5e5e3b': 'soggiorno',
};

let homeyTokens = null; // { session_token, refresh_token, expires_at }

async function loadHomeyTokens() {
  if (homeyTokens && homeyTokens.expires_at > Date.now() + 60000) return homeyTokens;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tokens?provider=eq.homey_tokens&select=data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await res.json();
    if (rows?.length && rows[0].data) {
      homeyTokens = rows[0].data;
      return homeyTokens;
    }
  } catch (e) { log(`Load Homey tokens failed: ${e.message}`, 'error'); }
  return null;
}

async function refreshHomeyToken(refreshToken) {
  try {
    const res = await fetch('https://api.athom.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: HOMEY_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) { log(`Homey refresh failed: ${res.status}`, 'error'); return null; }
    const data = await res.json();

    // Get delegation token for Homey device access
    const delRes = await fetch('https://api.athom.com/delegation/token?audience=homey', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (!delRes.ok) { log(`Homey delegation failed: ${delRes.status}`, 'error'); return null; }
    const del = await delRes.json();

    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      session_token: del.token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };

    // Save to Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ provider: 'homey_tokens', data: tokens, updated_at: new Date().toISOString() }),
    });

    homeyTokens = tokens;
    log('Homey token refreshed successfully');
    return tokens;
  } catch (e) {
    log(`Homey token refresh error: ${e.message}`, 'error');
    return null;
  }
}

async function getHomeySessionToken() {
  let tokens = await loadHomeyTokens();
  if (tokens && tokens.expires_at > Date.now()) return tokens.session_token;
  if (tokens?.refresh_token) {
    const refreshed = await refreshHomeyToken(tokens.refresh_token);
    if (refreshed) return refreshed.session_token;
  }
  // Fallback to env
  return process.env.HOMEY_SESSION_TOKEN || null;
}

async function pollSonoff() {
  const sessionToken = await getHomeySessionToken();
  if (!sessionToken) {
    log('No Homey session token — skipping Sonoff', 'warn');
    return {};
  }

  // Try local first, then cloud
  const urls = [
    `http://${HOMEY_IP}/api/manager/devices/device/`,
    `https://${HOMEY_ID}.connect.athom.com/api/manager/devices/device/`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401) {
        // Invalidate and try refresh on next call
        if (homeyTokens) homeyTokens.expires_at = 0;
        continue;
      }
      if (!res.ok) continue;

      const devices = await res.json();
      const readings = {};
      for (const [id, d] of Object.entries(devices)) {
        const roomId = HOMEY_DEVICE_MAP[id];
        if (!roomId || typeof d !== 'object') continue;
        const caps = d.capabilitiesObj;
        if (!caps) continue;
        const temp = caps.measure_temperature?.value;
        const hum = caps.measure_humidity?.value;
        if (temp != null) readings[roomId] = { temperature: temp, humidity: hum ?? 0 };
      }
      log(`Sonoff: ${Object.entries(readings).map(([r,v]) => `${r}=${v.temperature}°`).join(', ')}`);
      return readings;
    } catch {
      continue;
    }
  }
  log('All Homey endpoints failed', 'error');
  return {};
}

// --- Per-room state ---
const roomState = {};

function getRoomState(roomId) {
  if (!roomState[roomId]) {
    roomState[roomId] = {
      history: [],           // rolling window of { temp, timestamp }
      lastCommandCycle: 0,   // cycle number of last command sent
      commandTimestamps: [], // timestamps of commands sent (for rate limiting)
      lastSetpoint: null,
      lastFan: null,
      lastMode: null,
    };
  }
  return roomState[roomId];
}

let cycleCount = 0;

// --- Outdoor temperature (Open-Meteo, Porta Romana Milan) ---
const OUTDOOR_CACHE_MS = 30 * 60 * 1000; // 30 min cache
const OUTDOOR_API_URL = 'https://api.open-meteo.com/v1/forecast?latitude=45.4642&longitude=9.1900&current_weather=true';
let outdoorCache = { temp: null, fetchedAt: 0 };

async function fetchOutdoorTemp() {
  // Return cached value if fresh enough
  if (outdoorCache.temp !== null && Date.now() - outdoorCache.fetchedAt < OUTDOOR_CACHE_MS) {
    return outdoorCache.temp;
  }
  try {
    const res = await fetch(OUTDOOR_API_URL, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const temp = data.current_weather?.temperature;
    if (typeof temp === 'number') {
      outdoorCache = { temp, fetchedAt: Date.now() };
      return temp;
    }
    log('Open-Meteo: unexpected response shape', 'error');
    return outdoorCache.temp; // last known value (may be null)
  } catch (e) {
    log(`Open-Meteo fetch failed: ${e.message}`, 'error');
    return outdoorCache.temp; // last known value (may be null)
  }
}

// --- Stability scoring ---
function calcStdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function getStabilityScore(state) {
  if (state.history.length < 3) return null;
  const temps = state.history.map(h => h.temp);
  const stddev = calcStdDev(temps);
  return 1 / (1 + stddev);
}

// --- Trend calculation ---
// Returns degrees per cycle (10 min) based on last 3 readings
function calcTrend(state) {
  const h = state.history;
  if (h.length < 3) return 0;
  const recent = h.slice(-3);
  // Linear regression slope over last 3 points
  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i].temp;
    sumXY += i * recent[i].temp;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom; // degrees per cycle
}

// --- Control logic ---
// The agent NEVER changes mode — the building has a centralized HVAC system.
// Season (heat/cool) is set globally by the user. Fancoils must ALWAYS stay on.
// The agent only controls: setpoint and fan speed.
function computeControl(roomId, currentTemp, currentMode, currentSetpoint, currentFan, outdoorTemp) {
  const config = ROOM_CONFIG[roomId];
  const state = getRoomState(roomId);
  const target = (config.targetMin + config.targetMax) / 2;

  // Outdoor compensation: when it's colder outside, walls radiate less heat,
  // so the operative (perceived) temperature is lower than air temperature.
  // Compensate by raising the target.
  const REFERENCE_OUTDOOR = 10; // °C — mild day, no compensation
  const COMPENSATION_FACTOR = 0.1; // +0.1°C indoor per 1°C colder outside
  const outdoorCompensation = outdoorTemp !== null
    ? Math.max(0, (REFERENCE_OUTDOOR - outdoorTemp) * COMPENSATION_FACTOR)
    : 0;
  const adjustedTarget = target + outdoorCompensation;

  const error = adjustedTarget - currentTemp; // positive = too cold, negative = too hot
  const trend = calcTrend(state);
  const stabilityScore = getStabilityScore(state);
  const isCritical = config.critical;
  const absError = Math.abs(error);

  // --- Fan speed (decisive thresholds) ---
  let newFan;
  if (absError > 1.5) {
    newFan = 3; // High: aggressive correction
  } else if (absError > 0.5) {
    newFan = 2; // Med
  } else {
    newFan = 1; // Low: within ±0.5°C of target, minimal disturbance
  }

  // Critical room: always high fan when error is significant
  if (isCritical && absError > 1.5) {
    newFan = 3;
  }

  // --- Setpoint (aggressive overshoot for heating) ---
  let newSetpoint;
  if (absError < 0.5) {
    // Within deadband: maintain at adjusted target
    newSetpoint = adjustedTarget;
  } else if (error > 0) {
    // Too cold: overshoot setpoint aggressively (up to +4°C for large errors)
    const offset = error * 0.8;
    newSetpoint = adjustedTarget + Math.min(offset, 4);
  } else {
    // Too hot: undershoot setpoint
    const offset = absError * 0.5;
    newSetpoint = adjustedTarget - Math.min(offset, 3);
  }

  // CRITICAL FIX: In HEAT mode, NEVER set setpoint below current temp.
  // When setpoint < current temp in heat mode, the fancoil blows ambient (cool) air
  // instead of heated air — this is the opposite of what we want in winter.
  // Strategy: set setpoint at current temp (no heating, no cold air) and fan to minimum,
  // letting the room cool naturally via heat loss through walls/windows.
  if (currentMode === 'heat' && newSetpoint < currentTemp) {
    newSetpoint = currentTemp;
    newFan = 1; // minimum fan — reduce air circulation, let natural cooling work
  }

  // Safety cap: never exceed absolute bounds regardless of mode
  const safety = SAFETY_BOUNDS[roomId];
  if (safety) {
    newSetpoint = Math.max(safety.min, Math.min(safety.max, newSetpoint));
  }

  // Round to 0.5 degree increments (Sabiana resolution)
  newSetpoint = Math.round(newSetpoint * 2) / 2;

  return { newSetpoint, newFan, target, adjustedTarget, outdoorCompensation, error, trend, stabilityScore };
}

// --- Anti-oscillation checks ---
function canSendCommand(roomId) {
  const state = getRoomState(roomId);

  // Check minimum cycles between changes
  if (cycleCount - state.lastCommandCycle < MIN_CYCLES_BETWEEN_CHANGES) {
    return { allowed: false, reason: 'min_cycles_not_met' };
  }

  // Check hourly rate limit
  const hourAgo = Date.now() - 3600_000;
  state.commandTimestamps = state.commandTimestamps.filter(t => t > hourAgo);
  if (state.commandTimestamps.length >= MAX_COMMANDS_PER_HOUR) {
    return { allowed: false, reason: 'hourly_rate_limit' };
  }

  return { allowed: true, reason: null };
}

function shouldSkipDueToTrend(roomId, error, trend) {
  // If trend is already moving toward target at a good rate, don't change
  const movingToward = (error > 0 && trend > 0.05) || (error < 0 && trend < -0.05);
  const absError = Math.abs(error);
  // Only skip if error is moderate (not critical) and trend is strong
  if (movingToward && absError < 1.5) {
    return true;
  }
  return false;
}

function hasSignificantChange(roomId, newSetpoint, newFan) {
  const state = getRoomState(roomId);
  const spChanged = state.lastSetpoint !== null && Math.abs(newSetpoint - state.lastSetpoint) >= 0.5;
  const fanChanged = state.lastFan !== null && newFan !== state.lastFan;
  return spChanged || fanChanged;
}

// --- Alerting ---
const alertHistory = new Map();

function shouldAlert(key) {
  const last = alertHistory.get(key);
  if (last && Date.now() - last < ALERT_COOLDOWN_MS) return false;
  alertHistory.set(key, Date.now());
  return true;
}

async function sendAlert(severity, message, roomId) {
  log(`ALERT [${severity}] ${message}`);

  const channels = ['log'];

  // iMessage for critical and warning alerts
  if (severity === 'critical' || severity === 'warning') {
    try {
      await fetch(`${IMESSAGE_PROXY_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: IMESSAGE_RECIPIENT,
          message: `ThermoLeo [${severity.toUpperCase()}]: ${message}`,
        }),
      });
      channels.push('imessage');
    } catch (e) {
      log(`iMessage send failed: ${e.message}`, 'error');
    }
  }

  await supabaseInsert('alerts', [{
    room_id: roomId,
    alert_type: severity === 'critical' ? 'temp_critical' : 'temp_warning',
    severity,
    message,
    notified_via: channels,
  }]);
}

// --- Sabiana command sending ---
async function sendSabianaCommand(deviceId, temperature, mode, fan) {
  const token = await getValidToken();
  const modeMap = { cool: '0', heat: '1', fan_only: '3', off: '4' };
  const tempHex = Math.round(temperature * 10).toString(16).padStart(4, '0');
  const cmdData = `0${fan}0${modeMap[mode] || '1'}${tempHex}0401FFFF0000`;

  const res = await fetch(`${SABIANA_BASE}/devices/cmd`, {
    method: 'POST',
    headers: sabianaHeaders(token),
    body: JSON.stringify({ deviceID: deviceId, start: 2304, data: cmdData, restart: false }),
  });
  const data = await res.json();
  return data.status === 0;
}

// --- Netatmo Thermostat Control ---
// The Smarther 2 thermostat in soggiorno controls the zone valve.
// When its temp >= setpoint, the valve closes and ALL fancoils lose hot water.
// The agent must raise the thermostat setpoint when rooms are below target.

const THERMOSTAT_NETATMO_ROOM_ID = '2171004425'; // Smarther 2 room ID
const THERMOSTAT_MIN_SETPOINT = 15;
const THERMOSTAT_MAX_SETPOINT = 35;
let lastThermostatSetpoint = null;
let lastThermostatCommandTime = 0;
let originalThermostatSetpoint = null; // saved before agent overrides, restored when all OK
const THERMOSTAT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between thermostat adjustments

async function getNetatmoAccessToken() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tokens?provider=eq.netatmo&select=data`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const rows = await res.json();
    if (!rows?.length) return null;
    const tokenData = rows[0].data;

    // Check if token is expired (with 5min buffer)
    if (tokenData.expires_at && Date.now() > tokenData.expires_at - 300000) {
      // Refresh the token
      const refreshRes = await fetch('https://api.netatmo.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.NETATMO_CLIENT_ID || '',
          client_secret: process.env.NETATMO_CLIENT_SECRET || '',
          refresh_token: tokenData.refresh_token,
        }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.error) {
        log(`Netatmo token refresh failed: ${refreshData.error}`, 'error');
        return null;
      }
      const newTokenData = {
        access_token: refreshData.access_token,
        refresh_token: refreshData.refresh_token,
        expires_at: Date.now() + refreshData.expires_in * 1000,
        scope: refreshData.scope,
      };
      // Save refreshed token
      await fetch(
        `${SUPABASE_URL}/rest/v1/tokens?provider=eq.netatmo`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({ data: newTokenData, updated_at: new Date().toISOString() }),
        },
      );
      return newTokenData.access_token;
    }
    return tokenData.access_token;
  } catch (e) {
    log(`Netatmo token error: ${e.message}`, 'error');
    return null;
  }
}

async function getNetatmoHomeId() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tokens?provider=eq.netatmo_home&select=data`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const rows = await res.json();
    return rows?.[0]?.data?.home_id || null;
  } catch { return null; }
}

async function getThermostatStatus(accessToken, homeId) {
  try {
    const res = await fetch(
      `https://api.netatmo.com/api/homestatus?home_id=${homeId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const data = await res.json();
    if (data.error) return null;
    const rooms = data.body?.home?.rooms || [];
    return rooms.find(r => String(r.id) === THERMOSTAT_NETATMO_ROOM_ID) || null;
  } catch (e) {
    log(`Netatmo homestatus error: ${e.message}`, 'error');
    return null;
  }
}

async function setThermostatSetpoint(accessToken, homeId, temperature) {
  try {
    const res = await fetch('https://api.netatmo.com/api/setroomthermpoint', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        home_id: homeId,
        room_id: THERMOSTAT_NETATMO_ROOM_ID,
        mode: 'manual',
        temp: String(temperature),
        endtime: '0', // permanent until next schedule change
      }),
    });
    const data = await res.json();
    if (data.error) {
      log(`Netatmo setpoint error: ${data.error.message || data.error}`, 'error');
      return false;
    }
    return true;
  } catch (e) {
    log(`Netatmo setpoint failed: ${e.message}`, 'error');
    return false;
  }
}

// Check if any controlled fancoil hasn't reached its setpoint.
// HEAT mode: if any fancoil has temp < setpoint → raise thermostat (open valve for hot water)
// COOL mode: if any fancoil has temp > setpoint → lower thermostat (open valve for cold water)
// Once all fancoils reach target → restore thermostat to its original setpoint.
async function ensureThermostatSupportsRooms(devices) {
  const accessToken = await getNetatmoAccessToken();
  if (!accessToken) {
    log('Netatmo: no access token — skipping thermostat check');
    return;
  }
  const homeId = await getNetatmoHomeId();
  if (!homeId) {
    log('Netatmo: no home_id — skipping thermostat check');
    return;
  }

  const thermostat = await getThermostatStatus(accessToken, homeId);
  if (!thermostat) {
    log('Netatmo: thermostat not found — skipping');
    return;
  }

  const thermTemp = thermostat.therm_measured_temperature;
  const thermSetpoint = thermostat.therm_setpoint_temperature;
  if (thermTemp === undefined || thermSetpoint === undefined) return;
  if (lastThermostatSetpoint === null) lastThermostatSetpoint = thermSetpoint;

  log(`Thermostat: ${thermTemp}°C (setpoint ${thermSetpoint}°C)${originalThermostatSetpoint !== null ? ` [original: ${originalThermostatSetpoint}°C]` : ''}`);

  // Find any active fancoil that hasn't reached its setpoint
  const roomsNeedingClimate = devices
    .filter(d => DEVICE_TO_ROOM[d.deviceId])
    .filter(d => {
      const roomId = DEVICE_TO_ROOM[d.deviceId];
      const override = ROOM_OVERRIDES[roomId];
      if (override?.alwaysOff) return false;
      if (d.mode === 'off') return false;
      if (d.mode === 'heat') return d.temperature < d.setpoint - 0.3;
      if (d.mode === 'cool') return d.temperature > d.setpoint + 0.3;
      return false;
    });

  if (roomsNeedingClimate.length > 0) {
    // Determine dominant mode (heat or cool) from the devices that need climate
    const isHeating = roomsNeedingClimate.some(d => d.mode === 'heat');
    const isCooling = roomsNeedingClimate.some(d => d.mode === 'cool');

    // Calculate needed thermostat setpoint to keep valve open
    let neededSetpoint;
    let valveBlocked;
    if (isHeating) {
      // HEAT: valve closes when thermTemp >= thermSetpoint → raise setpoint above thermTemp
      neededSetpoint = Math.min(THERMOSTAT_MAX_SETPOINT, thermTemp + 3);
      valveBlocked = thermTemp >= thermSetpoint - 0.5;
    } else {
      // COOL: valve closes when thermTemp <= thermSetpoint → lower setpoint below thermTemp
      neededSetpoint = Math.max(THERMOSTAT_MIN_SETPOINT, thermTemp - 3);
      valveBlocked = thermTemp <= thermSetpoint + 0.5;
    }

    if (valveBlocked) {
      if (Date.now() - lastThermostatCommandTime < THERMOSTAT_COOLDOWN_MS) {
        log(`Thermostat: ${roomsNeedingClimate.length} rooms need ${isHeating ? 'heat' : 'cool'} but cooldown active`);
        return;
      }

      // Save original setpoint before first override
      if (originalThermostatSetpoint === null) {
        originalThermostatSetpoint = thermSetpoint;
        log(`Thermostat: saving original setpoint ${originalThermostatSetpoint}°C`);
      }

      const roomDetails = roomsNeedingClimate.map(d => {
        const rid = DEVICE_TO_ROOM[d.deviceId];
        return `${rid}: ${d.temperature}→${d.setpoint}°C`;
      }).join(', ');

      const direction = isHeating ? 'raising' : 'lowering';
      log(`Thermostat: ${direction} setpoint ${thermSetpoint}→${neededSetpoint}°C — ${roomDetails}`);
      const success = await setThermostatSetpoint(accessToken, homeId, neededSetpoint);
      if (success) {
        lastThermostatSetpoint = neededSetpoint;
        lastThermostatCommandTime = Date.now();
        await logAction('_thermostat', 'setpoint_change', thermSetpoint, neededSetpoint,
          `valve override (${isHeating ? 'heat' : 'cool'}): ${roomDetails}`, null, 0, 0);
        await sendAlert('info',
          `Termostato zona: ${thermSetpoint}→${neededSetpoint}°C per aprire valvola (${roomsNeedingClimate.map(d => DEVICE_TO_ROOM[d.deviceId]).join(', ')})`,
          '_thermostat');
      }
    } else {
      log(`Thermostat: valve open, ${roomsNeedingClimate.length} rooms ${isHeating ? 'heating' : 'cooling'} normally`);
    }
  } else if (originalThermostatSetpoint !== null) {
    // All fancoils reached target — restore thermostat to original setpoint
    if (Date.now() - lastThermostatCommandTime < THERMOSTAT_COOLDOWN_MS) {
      log(`Thermostat: all rooms OK, will restore original setpoint after cooldown`);
      return;
    }

    log(`Thermostat: all rooms at target — restoring original setpoint ${thermSetpoint}→${originalThermostatSetpoint}°C`);
    const success = await setThermostatSetpoint(accessToken, homeId, originalThermostatSetpoint);
    if (success) {
      lastThermostatSetpoint = originalThermostatSetpoint;
      lastThermostatCommandTime = Date.now();
      await logAction('_thermostat', 'setpoint_restore', thermSetpoint, originalThermostatSetpoint,
        'all fancoils at target — restoring original setpoint', null, 0, 0);
      originalThermostatSetpoint = null; // clear — back to normal
      log(`Thermostat: original setpoint restored`);
    }
  } else {
    log(`Thermostat: all active fancoils at target — OK`);
  }
}

// --- Log agent action to Supabase ---
async function logAction(roomId, actionType, oldValue, newValue, reason, stabilityScore, error, trend) {
  await supabaseInsert('agent_actions', [{
    room_id: roomId,
    action_type: actionType,
    old_value: String(oldValue),
    new_value: String(newValue),
    reason,
    stability_score: stabilityScore,
    error_magnitude: Math.abs(error),
    trend,
  }]);
}

// --- Main poll cycle ---
async function pollCycle() {
  try {
    cycleCount++;
    const [devices, sonoffReadings, outdoorTemp] = await Promise.all([
      pollSabiana(),
      pollSonoff(),
      fetchOutdoorTemp(),
    ]);
    const now = new Date().toISOString();

    // Replace device temperatures with Sonoff readings (only source of truth)
    for (const device of devices) {
      const roomId = DEVICE_TO_ROOM[device.deviceId];
      if (roomId) {
        device.temperature = sonoffReadings[roomId]?.temperature ?? null;
      }
    }

    // Outdoor compensation preview (computed once for logging)
    const REFERENCE_OUTDOOR = 10;
    const COMPENSATION_FACTOR = 0.1;
    const outdoorCompensation = outdoorTemp !== null
      ? Math.max(0, (REFERENCE_OUTDOOR - outdoorTemp) * COMPENSATION_FACTOR)
      : 0;
    log(`Outdoor: ${outdoorTemp}°C → compensation +${outdoorCompensation.toFixed(1)}°C`);

    // --- 1. Save readings to Supabase ---
    const readings = devices
      .filter(d => DEVICE_TO_ROOM[d.deviceId])
      .map(d => ({
        room_id: DEVICE_TO_ROOM[d.deviceId],
        measured_at: now,
        temperature: d.temperature,
        setpoint: d.setpoint,
        fan_speed: d.fanSpeed,
        mode: d.mode,
        heating_active: d.mode === 'heat' && d.temperature < d.setpoint,
        outdoor_temp: outdoorTemp,
        outdoor_compensation: outdoorCompensation,
      }));

    if (readings.length > 0) {
      await supabaseInsert('readings', readings);
    }

    // --- 2. Control loop for each room ---
    // Sort by priority (critical rooms first)
    const sortedDevices = devices
      .filter(d => DEVICE_TO_ROOM[d.deviceId])
      .sort((a, b) => {
        const ra = ROOM_CONFIG[DEVICE_TO_ROOM[a.deviceId]];
        const rb = ROOM_CONFIG[DEVICE_TO_ROOM[b.deviceId]];
        return (ra?.priority || 99) - (rb?.priority || 99);
      });

    for (const device of sortedDevices) {
      const roomId = DEVICE_TO_ROOM[device.deviceId];
      if (!roomId) continue;
      const config = ROOM_CONFIG[roomId];
      if (!config) continue;

      const state = getRoomState(roomId);
      const temp = device.temperature;

      // Update history (rolling window)
      state.history.push({ temp, timestamp: Date.now() });
      if (state.history.length > HISTORY_WINDOW) {
        state.history.shift();
      }

      // Initialize last known values on first cycle
      if (state.lastSetpoint === null) {
        state.lastSetpoint = device.setpoint;
        state.lastFan = device.fanSpeed;
        state.lastMode = device.mode;
      }

      // --- Safety alerts (always check, independent of control) ---
      const safety = SAFETY_BOUNDS[roomId];
      if (temp < safety.min) {
        const key = `${roomId}_temp_low_critical`;
        if (shouldAlert(key)) {
          await sendAlert('critical', `${device.deviceName}: ${temp}°C - sotto minimo sicuro (${safety.min}°C)!`, roomId);
        }
      }
      if (temp > safety.max) {
        const key = `${roomId}_temp_high_critical`;
        if (shouldAlert(key)) {
          await sendAlert('critical', `${device.deviceName}: ${temp}°C - sopra massimo sicuro (${safety.max}°C)!`, roomId);
        }
      }

      // Warning: outside ideal range (only for Nursery)
      if (config.critical && (temp < config.targetMin || temp > config.targetMax)) {
        const key = `${roomId}_temp_ideal`;
        if (shouldAlert(key)) {
          await sendAlert('warning',
            `${device.deviceName}: ${temp}°C - fuori range ideale (${config.targetMin}-${config.targetMax}°C)`,
            roomId);
        }
      }

      // Alert: temp >0.5°C above target → iMessage to open window
      if (temp > config.targetMax + 0.5) {
        const key = `${roomId}_open_window`;
        if (shouldAlert(key)) {
          const roomNames = { leone: 'Camera Nursery', soggiorno: 'Soggiorno', camera: 'Camera da letto', studio: 'Studio', cucina: 'Cucina' };
          await sendAlert('warning',
            `${roomNames[roomId] || roomId}: ${temp}°C (target ${config.targetMax}°C) — apri la finestra!`,
            roomId);
        }
      }

      // Device offline
      if (!device.connectionUp) {
        const key = `${roomId}_offline`;
        if (shouldAlert(key)) {
          await sendAlert('critical', `${device.deviceName}: dispositivo OFFLINE!`, roomId);
        }
        continue; // Skip control for offline devices
      }

      // --- Room override: Camera da letto always OFF ---
      const override = ROOM_OVERRIDES[roomId];
      if (override?.alwaysOff) {
        if (device.mode !== 'off') {
          const success = await sendSabianaCommand(device.deviceId, device.setpoint, 'off', 1);
          if (success) {
            log(`${roomId}: OVERRIDE — forcing OFF (alwaysOff rule)`);
            await logAction(roomId, 'mode_change', device.mode, 'off',
              'user override: camera da letto always off', null, 0, 0);
            state.lastMode = 'off';
          } else {
            log(`${roomId}: OVERRIDE OFF command FAILED — will retry next cycle`, 'error');
            const key = `${roomId}_override_failed`;
            if (shouldAlert(key)) {
              await sendAlert('warning', `${device.deviceName}: impossibile spegnere (override alwaysOff fallito)`, roomId);
            }
          }
        }
        continue;
      }

      // --- Compute desired control values ---
      const ctrl = computeControl(
        roomId, temp, device.mode, device.setpoint, device.fanSpeed, outdoorTemp
      );

      // --- Decide whether to send a command ---
      const needsChange = hasSignificantChange(roomId, ctrl.newSetpoint, ctrl.newFan);

      // First cycle: always send to ensure devices are at correct settings
      const isFirstCommand = state.commandTimestamps.length === 0;

      if (!needsChange && !isFirstCommand) {
        // No change needed — log status and move on
        if (cycleCount % 3 === 0) { // every 30 min (3 cycles × 10 min), log stability
          const score = ctrl.stabilityScore;
          if (score !== null) {
            const targetLabel = ctrl.outdoorCompensation > 0
              ? `${ctrl.target}+${ctrl.outdoorCompensation.toFixed(1)}=${ctrl.adjustedTarget.toFixed(1)}`
              : `${ctrl.target}`;
            log(`${roomId}: ${temp}°C (target ${targetLabel}°C) stability=${score.toFixed(3)} trend=${ctrl.trend.toFixed(3)}°C/cycle`);
          }
        }
        continue;
      }

      // Anti-oscillation gate
      const { allowed, reason: blockReason } = canSendCommand(roomId);
      if (!allowed && !isFirstCommand) {
        // For critical safety situations, override the gate
        const isSafetyOverride = config.critical && Math.abs(ctrl.error) > 2;
        if (!isSafetyOverride) {
          log(`${roomId}: command blocked (${blockReason}), error=${ctrl.error.toFixed(1)}°C`);
          continue;
        }
        log(`${roomId}: SAFETY OVERRIDE - command allowed despite ${blockReason}`);
      }

      // Trend-based skip (don't interfere if things are improving)
      if (!isFirstCommand && shouldSkipDueToTrend(roomId, ctrl.error, ctrl.trend)) {
        log(`${roomId}: skipping (trend ${ctrl.trend.toFixed(3)}°C/cycle moving toward target, error=${ctrl.error.toFixed(1)}°C)`);
        continue;
      }

      // --- Send command (always use device's current mode — agent never changes mode) ---
      const currentMode = device.mode;
      const success = await sendSabianaCommand(
        device.deviceId, ctrl.newSetpoint, currentMode, ctrl.newFan
      );

      if (success) {
        // Build reason string
        const reasons = [];
        if (Math.abs(ctrl.newSetpoint - state.lastSetpoint) >= 0.5) {
          reasons.push(`setpoint ${state.lastSetpoint}→${ctrl.newSetpoint}`);
        }
        if (ctrl.newFan !== state.lastFan) {
          reasons.push(`fan ${state.lastFan}→${ctrl.newFan}`);
        }
        const reasonStr = `error=${ctrl.error.toFixed(1)}°C trend=${ctrl.trend.toFixed(3)}°C/cyc | ${reasons.join(', ')}`;

        log(`${roomId}: CMD sent — sp=${ctrl.newSetpoint} fan=${ctrl.newFan} mode=${currentMode} (unchanged) | ${reasonStr}`);

        // Log individual action types to Supabase
        if (Math.abs(ctrl.newSetpoint - state.lastSetpoint) >= 0.5 || isFirstCommand) {
          await logAction(roomId, 'setpoint_change',
            state.lastSetpoint, ctrl.newSetpoint,
            `error=${ctrl.error.toFixed(1)}°C, trend=${ctrl.trend.toFixed(3)}`,
            ctrl.stabilityScore, ctrl.error, ctrl.trend);
        }
        if (ctrl.newFan !== state.lastFan || isFirstCommand) {
          await logAction(roomId, 'fan_change',
            state.lastFan, ctrl.newFan,
            `|error|=${Math.abs(ctrl.error).toFixed(1)}°C, ${Math.abs(ctrl.error) > 2 ? 'aggressive' : Math.abs(ctrl.error) > 1 ? 'moderate' : 'stable'}`,
            ctrl.stabilityScore, ctrl.error, ctrl.trend);
        }

        // Update state
        state.lastSetpoint = ctrl.newSetpoint;
        state.lastFan = ctrl.newFan;
        state.lastMode = currentMode;
        state.lastCommandCycle = cycleCount;
        state.commandTimestamps.push(Date.now());
      } else {
        log(`${roomId}: command FAILED`, 'error');
      }
    }

    // --- 3. Thermostat zone valve guardian ---
    // Ensure thermostat setpoint is high enough to keep hot water flowing
    await ensureThermostatSupportsRooms(devices);

    log(`Cycle #${cycleCount} complete: ${readings.length} readings, ${sortedDevices.length} rooms controlled`);
  } catch (e) {
    log(`Poll error: ${e.message}`, 'error');
  }
}

// --- Logging ---
function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const prefix = level === 'error' ? 'ERROR' : 'INFO';
  console.log(`[${ts}] [${prefix}] ${msg}`);
}

// --- Main ---
async function main() {
  log('ThermoLeo Intelligent Controller starting...');
  log(`Rooms: ${Object.keys(ROOM_CONFIG).join(', ')}`);
  log(`Targets: ${Object.entries(ROOM_CONFIG).map(([r, c]) => `${r}=${c.targetMin}-${c.targetMax}°C`).join(', ')}`);
  log(`Control: poll=${POLL_NORMAL_MS / 1000}s (normal) / ${POLL_ACTIVE_MS / 1000}s (active), min_cycles=${MIN_CYCLES_BETWEEN_CHANGES}, max_cmds/hr=${MAX_COMMANDS_PER_HOUR}`);

  if (!SABIANA_EMAIL || !SABIANA_PASSWORD) {
    log('SABIANA_EMAIL and SABIANA_PASSWORD required', 'error');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log('SUPABASE_URL and SUPABASE_KEY required', 'error');
    process.exit(1);
  }

  // Adaptive polling loop
  async function adaptiveLoop() {
    await pollCycle();

    // Determine next interval based on whether any room is actively correcting
    const anyActiveCorrection = Object.keys(ROOM_CONFIG).some(roomId => {
      const state = getRoomState(roomId);
      if (state.history.length === 0) return false;
      const lastTemp = state.history[state.history.length - 1]?.temp;
      if (lastTemp === undefined) return false;
      const config = ROOM_CONFIG[roomId];
      // Active if temperature is outside target range
      return lastTemp < config.targetMin - 0.3 || lastTemp > config.targetMax + 0.3;
    });

    const nextInterval = anyActiveCorrection ? POLL_ACTIVE_MS : POLL_NORMAL_MS;
    if (anyActiveCorrection) {
      log(`Adaptive: active correction detected — next poll in ${nextInterval / 1000}s`);
    }
    setTimeout(adaptiveLoop, nextInterval);
  }

  await adaptiveLoop();
  log(`Adaptive polling started: ${POLL_ACTIVE_MS / 1000}s (active) / ${POLL_NORMAL_MS / 1000}s (stable). Ctrl+C to stop.`);
}

main().catch(e => {
  log(`Fatal: ${e.message}`, 'error');
  process.exit(1);
});
