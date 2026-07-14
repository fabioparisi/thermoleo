/**
 * ThermoLeo Agent v2 — Hysteresis state machine with on/off control
 *
 * Each room has a state: HEATING | SATISFIED | SENSOR_FAULT | DISABLED
 * Transitions use hysteresis dead bands to prevent oscillation.
 * Nursery (baby room) has tighter bands and priority over all other rooms.
 */

import { NextResponse } from 'next/server';
import { getDeviceStates } from '@/lib/sabiana/client';
import { loadBridgeReadings, loadShellyCampomarino } from '@/lib/bridge';
import { loadTopology } from '@/lib/topology';
import { loadAgentState, saveAgentState, getRoomState } from '@/lib/agent/state';
import { SAFETY_BOUNDS, SENSOR_FAULT_THRESHOLD, type RoomConfig } from '@/lib/agent/safety';
import { getValidToken } from '@/lib/sabiana/token-manager';
import type { RoomRow } from '@/lib/supabase/types';
import { supaGet, supaInsert } from '@/lib/supabase/rest';
import { manageThermostat } from '@/lib/agent/thermostat';
import { processRoom, sendAlert, shutdownRoomOff, DISABLED_ROOMS, type ProcessRoomDevice } from '@/lib/agent/state-machine';
import { loadSeason } from '@/lib/agent/season';
import { runOffMilanoGuard, type ShutdownResult } from '@/lib/agent/off-guard';
import { ensureBathroomsAntifrozen } from '@/lib/agent/bathroom-antifreeze';
import { ensureSmartherSummerOpen, ensureSmartherClosed } from '@/lib/agent/smarther-summer';
import { listDevices as listMelDevices } from '@/lib/melcloud/client';
import { processSplitRoom } from '@/lib/agent/campomarino';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

// ─── Room Configuration ────────────────────────────────────────────────────────

const HYSTERESIS = 0.5; // ±0.5°C around target — dead-band to minimize hunting

// Mitsubishi splits read return air, ~1.5°C below the real room. Applied to the
// split's reported temp ONLY when used as a fallback (no fresh Shelly reading).
// The Shelly freshness cutoff lives in bridge.ts (loadShellyCampomarino).
const SPLIT_COLD_BIAS = 1.5;

const ROOM_PRIORITIES: Record<string, { critical: boolean; priority: number }> = {
  leone:     { critical: true, priority: 1 },
  soggiorno: { critical: false, priority: 2 },
  camera:    { critical: false, priority: 2 },
  studio:    { critical: false, priority: 2 },
  cucina:    { critical: false, priority: 3 },
  bagno1:    { critical: false, priority: 3 },
  bagno2:    { critical: false, priority: 3 },
};

// ─── Outdoor temperature compensation ─────────────────────────────────────────
// Cold outdoor temps lower wall/window surface temps (mean radiant temperature),
// making rooms feel colder than the air thermometer reads.
// Formula: +0.06°C per degree below 20°C outdoor (EN 16798-1, U_wall≈1.0)
// Clamped to max +1.5°C. Uses current outdoor temp (no averaging).
const OUTDOOR_COMP_K = 0.06;        // °C offset per °C below reference
const OUTDOOR_COMP_REF = 20;        // reference outdoor temp (no compensation above this)
const OUTDOOR_COMP_MAX = 1.5;       // max compensation clamp

function outdoorCompensation(outdoorTemp: number | null): number {
  if (outdoorTemp === null) return 0;
  const delta = Math.max(0, OUTDOOR_COMP_REF - outdoorTemp);
  return Math.min(OUTDOOR_COMP_MAX, OUTDOOR_COMP_K * delta);
}

/**
 * Phase 3b: resolve one life-safety bound from a DB-sourced value, falling back
 * to the SAFETY_BOUNDS constant (and warning loudly) when the column is
 * null/non-finite. A silent fallback would mask seed drift on a baby-room
 * bound; the warn fires ONLY on the abnormal branch, so the healthy Milano
 * cycle log stays byte-identical. `Math.max(null, x)` coerces null→0, so a raw
 * null here would silently collapse a floor to 0°C — hence the explicit guard.
 */
function resolveBound(roomId: string, dbValue: number | null | undefined, fallback: number, which: 'min' | 'max'): number {
  const n = Number(dbValue);
  if (Number.isFinite(n)) return n;
  console.warn(`[agent] room ${roomId} missing safety_${which} (got ${dbValue}); using hardcoded fallback ${fallback}`);
  return fallback;
}

/** Load room targets + safety bounds from DB → build RoomConfig map with outdoor compensation.
 *  Filtered by property so a Milano cycle sees ONLY Milano rooms (strict
 *  isolation; the 3 Campomarino rooms are a different property). Uncached — read
 *  fresh every cycle so `actuation_enabled` flips take effect next tick. */
async function loadRoomConfigs(outdoorTemp: number | null, propertyId = 'milano'): Promise<Record<string, RoomConfig>> {
  const rows = await supaGet<RoomRow[]>(
    `/rest/v1/rooms?select=id,target_temp,safety_min,safety_max,critical,fan_profile,api_source,device_id,actuation_enabled&property_id=eq.${encodeURIComponent(propertyId)}`,
    { timeout: 5000 },
  );
  const configs: Record<string, RoomConfig> = {};
  const comp = outdoorCompensation(outdoorTemp);
  // Campomarino's splits chase the UI target tighter than Milano's fancoils:
  // a 0.3°C dead-band (vs Milano's 0.5) holds the room closer to target without
  // short-cycling — the 5-min cycle is already an implicit ~5-min min-off, so it
  // physically can't toggle faster than that (Fabio 2026-06-21, board Opus+GLM:
  // floor is 0.2; 0.3 keeps a safe margin above sensor noise). Milano is untouched.
  const hysteresis = propertyId === 'campomarino' ? 0.3 : HYSTERESIS;
  for (const row of rows) {
    // Phase 3b: bounds come from the DB row, finite-guarded with the
    // SAFETY_BOUNDS constant as the loud fallback. fb defaults (16/35) cover an
    // unknown room with no constant entry — same shape as the former
    // `safety ? ... : default` paths.
    const fb = SAFETY_BOUNDS[row.id];
    const safetyMin = resolveBound(row.id, row.safety_min, fb ? fb.min : 16, 'min');
    const safetyMax = resolveBound(row.id, row.safety_max, fb ? fb.max : 35, 'max');
    // NaN guard: a non-numeric target_temp would make every Math.max/min clamp
    // return NaN (NaN comparisons are false), poisoning config.target and
    // eventually encoding a malformed command. Fall back to a safe in-bounds
    // default instead of letting NaN through.
    const rawTarget = Number(row.target_temp);
    const baseTarget = Number.isFinite(rawTarget)
      ? rawTarget
      : Math.round((safetyMin + safetyMax) / 2);
    const t = Math.round((baseTarget + comp) * 2) / 2; // round to 0.5°C step
    // priority TIER stays hardcoded (ROOM_PRIORITIES) — the rooms.priority
    // column is a different (UI-sort) scheme. critical moves to the DB column
    // (Phase 3b), falling back to the constant when absent.
    const meta = ROOM_PRIORITIES[row.id] || { critical: false, priority: 3 };
    const critical = typeof row.critical === 'boolean' ? row.critical : meta.critical;
    // fan_profile: trust only the known 'silent' value; anything else (null,
    // unknown) defaults to 'standard' (the safe/louder ladder).
    const fanProfile: 'standard' | 'silent' = row.fan_profile === 'silent' ? 'silent' : 'standard';
    const clamped = Math.max(safetyMin, Math.min(safetyMax, t));
    // Phase 8: vendor + actuation gate. FAIL CLOSED — only an explicit boolean
    // `true` enables actuation; null/undefined/missing → false. apiSource
    // defaults to 'sabiana' so a pre-Phase-8 Milano row (no column read before)
    // keeps its vendor; deviceId is null for device-less rooms (bathrooms).
    const apiSource = typeof row.api_source === 'string' ? row.api_source : 'sabiana';
    const deviceId = typeof row.device_id === 'string' ? row.device_id : null;
    const actuationEnabled = row.actuation_enabled === true;
    configs[row.id] = {
      target: clamped,
      baseTarget,
      compensation: Math.round((clamped - baseTarget) * 10) / 10,
      onThreshold: clamped - hysteresis,
      offThreshold: clamped + hysteresis,
      critical,
      priority: meta.priority,
      safetyMin,
      safetyMax,
      fanProfile,
      apiSource,
      deviceId,
      actuationEnabled,
    };
  }
  return configs;
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(request: Request): boolean {
  const secret = process.env.AGENT_CRON_SECRET;
  if (!secret) {
    // Fail CLOSED. An empty secret used to fall through to `true` which made
    // the endpoint publicly triggerable in any environment missing the env
    // var — hardware actuation should never be reachable by anonymous
    // internet traffic.
    console.error('[agent] AGENT_CRON_SECRET not set — refusing to run');
    return false;
  }
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

// Bridge readings are imported from @/lib/bridge — the helper handles
// freshness filtering, error fallback, and is shared with /api/rooms.

// ─── Outdoor temp ──────────────────────────────────────────────────────────────

// Per-property coordinates, read from the `properties` table and cached per
// property (lat/lon never change). Falls back to Milano's coords if the row is
// missing, so a meteo lookup never throws the cycle off course.
const MILANO_COORDS = { lat: 45.4642, lon: 9.1900 };
const coordsCache = new Map<string, { lat: number; lon: number }>();

async function propertyCoords(propertyId: string): Promise<{ lat: number; lon: number }> {
  const hit = coordsCache.get(propertyId);
  if (hit) return hit;
  try {
    const rows = await supaGet<Array<{ lat: number; lon: number }>>(
      `/rest/v1/properties?select=lat,lon&id=eq.${encodeURIComponent(propertyId)}`,
      { timeout: 5000 },
    );
    const row = rows?.[0];
    const coords =
      row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon))
        ? { lat: Number(row.lat), lon: Number(row.lon) }
        : MILANO_COORDS;
    coordsCache.set(propertyId, coords);
    return coords;
  } catch {
    return MILANO_COORDS;
  }
}

async function fetchOutdoorTemp(propertyId = 'milano'): Promise<number | null> {
  try {
    const { lat, lon } = await propertyCoords(propertyId);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&forecast_days=1`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await res.json();
    return data.current?.temperature_2m ?? null;
  } catch { return null; }
}

// ─── Main cycle ────────────────────────────────────────────────────────────────

/** Properties the cycle knows how to run. An unknown `?property` is a 400, NEVER
 *  a silent fall-through to the campomarino branch — a typo (`?property=Milano`)
 *  must not drop Milano into a read-only mode in winter. (Board: Opus Q2 trap,
 *  GLM A2.) */
const KNOWN_PROPERTIES = new Set(['milano', 'campomarino']);

// ─── Campomarino cycle (MELCloud splits, no boiler/Smarther/bathroom) ────────────

/**
 * Self-contained cycle for a non-Milano home (today: campomarino, 3 Mitsubishi
 * MELCloud splits). Reads the splits, records readings, and — only for a room
 * whose `actuation_enabled` is true — commands heat/cool/off. All 3 campomarino
 * rooms ship `actuation_enabled=false`, so today this branch is READ + LOG +
 * RECORD with ZERO actuation; the gate is the per-room early-continue before any
 * setAta. NO Sabiana client is ever constructed here (no shared tokenHolder).
 *
 * Sensor source: the split's own internal `roomTemperature` for now; a fresh
 * Shelly H&T reading (Phase 8.7) will override it once installed/validated. A
 * split reporting Power=off has a stale internal probe, so its temp is nulled
 * (don't act on a frozen reading).
 */
async function runCampomarinoCycle(
  propertyId: string,
  state: import('@/lib/agent/state').AgentState,
  startTime: number,
  log: string[],
  addLog: (msg: string) => void,
  onlyRoomId?: string, // when set, process ONLY this room (immediate push after a UI target change)
): Promise<NextResponse> {
  try {
    const [melDevices, outdoorTemp, season, shellyReadings] = await Promise.all([
      listMelDevices().catch(e => {
        addLog(`MELCloud error: ${e instanceof Error ? e.message : 'unknown'}`);
        return [] as Awaited<ReturnType<typeof listMelDevices>>;
      }),
      fetchOutdoorTemp(propertyId).catch(() => null),
      loadSeason(propertyId).catch(e => {
        addLog(`Season error: ${e instanceof Error ? e.message : 'unknown'} — fail-safe heat`);
        return 'heat' as const;
      }),
      // Shelly H&T readings (real room air, 3-min freshness). These OVERRIDE the
      // split's own sensor, which reads ~1.5°C cold (return air) and made the
      // agent shut off above target. Fresh Shelly wins; stale → split fallback.
      loadShellyCampomarino().catch(e => {
        addLog(`Shelly bridge error: ${e instanceof Error ? e.message : 'unknown'}`);
        return {} as Record<string, { temperature: number; humidity: number | null }>;
      }),
    ]);
    const [ROOM_CONFIG, topology] = await Promise.all([
      loadRoomConfigs(outdoorTemp, propertyId),
      loadTopology({ propertyId }),
    ]);
    // MELCloud deviceId is numeric; rooms.device_id is TEXT — we resolve the
    // other direction (room → its numeric device id, via Number(cfg.deviceId)).
    const byDevice = new Map(melDevices.map(d => [d.deviceId, d]));
    // Humidity comes from the Shelly H&T (real room air). null → split runs 'dry'.
    const humidityByRoom: Record<string, number | null> = {};
    for (const [rid, r] of Object.entries(shellyReadings)) {
      humidityByRoom[rid] = r.humidity;
    }

    const now = new Date().toISOString();
    const readings: Array<Record<string, unknown>> = [];
    let actuated = 0, gated = 0, sensorsRead = 0;

    for (const room of Object.values(topology.rooms)) {
      // Targeted push: a UI target change calls this cycle with ?room=<id> so
      // only that split re-evaluates immediately (no 5-min wait), without driving
      // the other rooms' MELCloud writes. Empty/absent → full property cycle.
      if (onlyRoomId && room.id !== onlyRoomId) continue;
      const cfg = ROOM_CONFIG[room.id];
      if (!cfg || cfg.apiSource !== 'melcloud' || !cfg.deviceId) continue;
      const melId = Number(cfg.deviceId);
      if (!Number.isSafeInteger(melId)) {
        addLog(`${room.id}: invalid melcloud device_id '${cfg.deviceId}' — skipped`);
        continue;
      }
      const dev = byDevice.get(melId);
      // TEMP SOURCE, in priority order:
      //   1. Shelly H&T (real room air, fresh ≤3min) — the truth.
      //   2. Split's own sensor + SPLIT_COLD_BIAS — it reads return air, ~1.5°C
      //      below the real room, so a bare fallback makes the agent shut off
      //      while the room is actually target+1.5°C. Correct it.
      // Both plausibility-gated (5..45°C). null only if NEITHER source is usable
      // → SENSOR_FAULT downstream.
      const shelly = shellyReadings[room.id];
      const rawSplit = dev?.roomTemperature ?? null;
      let temp: number | null = null;
      let tempSrc = 'none';
      if (shelly && Number.isFinite(shelly.temperature) && shelly.temperature > 5 && shelly.temperature < 45) {
        temp = shelly.temperature;
        tempSrc = 'shelly';
      } else if (rawSplit !== null && Number.isFinite(rawSplit) && rawSplit > 5 && rawSplit < 45) {
        temp = Math.round((rawSplit + SPLIT_COLD_BIAS) * 10) / 10;
        tempSrc = 'split+bias';
      }
      const humidity = humidityByRoom[room.id] ?? null;
      if (temp !== null) sensorsRead++;
      if (tempSrc !== 'none') addLog(`${room.id}: temp=${temp}°C (${tempSrc})`);

      // Record the reading (property_id EXPLICIT — the column defaults to
      // 'milano', so a spread without it would mis-file the row).
      readings.push({
        room_id: room.id,
        property_id: propertyId,
        measured_at: now,
        temperature: temp,
        setpoint: dev?.setTemperature ?? null,
        fan_speed: dev?.fanSpeed ?? null,
        mode: season === 'off' ? 'off' : season === 'cool' ? 'cool' : 'heat',
        heating_active: false,
        outdoor_temp: outdoorTemp,
      });

      // ── ACTUATION ──
      // Gate (fail closed): only an explicit actuation_enabled=true room actuates.
      // season=off → everything stays off (no commands); the split is left as the
      // user set it. Otherwise hand the room to the per-split state machine, which
      // applies the same hysteresis + rate-limits as Milano and decides dry/cool
      // by humidity. Disabled rooms still get their reading recorded above.
      if (!cfg.actuationEnabled || season === 'off') {
        // Clear a stale manual fan override when the home goes off-season — a fan
        // speed set last summer must NOT silently apply on the first cool command
        // months later (board Opus+GLM). UI clear is the in-season path.
        if (season === 'off') { const rs = getRoomState(state, room.id); if (rs.manualFan != null) rs.manualFan = null; if (rs.manualMode != null) rs.manualMode = null; }
        gated++; continue;
      }
      // SEQUENTIAL on purpose: parallel setAta+getDevice against the same MELCloud
      // account hits the per-building write lock / shared device cache → a verify
      // could read stale state and falsely confirm. 3 rooms × ~6s ≈ 18s « 55s.
      await processSplitRoom({ roomId: room.id, state, config: cfg, dev, temp, humidity, addLog });
      actuated++;
    }

    if (readings.length > 0) supaInsert('readings', readings).catch(() => {});
    addLog(`Cycle #${state.cycleCount} [campomarino] | Outdoor: ${outdoorTemp}°C | splits read: ${sensorsRead}/${readings.length} | season=${season}`);
    addLog(`campomarino: actuated=${actuated} gated=${gated}`);

    state.lastCycleTime = Date.now();
    await saveAgentState(state);

    const elapsed = Date.now() - startTime;
    addLog(`Cycle done in ${elapsed}ms | property=${propertyId}`);
    return NextResponse.json({ ok: true, cycle: state.cycleCount, property: propertyId, elapsed, log });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown';
    addLog(`FATAL: ${msg}`);
    await saveAgentState(state);
    return NextResponse.json({ ok: false, error: msg, property: propertyId, log }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Which home is this cycle for? Default 'milano' (back-compat: the existing
  // pg_cron call has no ?property → runs Milano exactly as before). Normalize
  // to lowercase and reject anything unknown.
  const propertyId = (new URL(request.url).searchParams.get('property') ?? 'milano').toLowerCase();
  if (!KNOWN_PROPERTIES.has(propertyId)) {
    return NextResponse.json({ ok: false, error: 'unknown_property', property: propertyId }, { status: 400 });
  }

  const startTime = Date.now();
  const state = await loadAgentState(propertyId);
  state.cycleCount++;

  const log: string[] = [];
  const addLog = (msg: string) => { console.log(`[agent] ${msg}`); log.push(msg); };

  // Campomarino (and any future non-Milano home) runs a self-contained branch:
  // MELCloud splits only, no boiler/Smarther/bathroom hardware. Dispatched here
  // as an early return so the entire Milano body below stays BYTE-IDENTICAL
  // (literally unchanged — the dispatch is the only line Milano ever sees, and
  // it's false for Milano). The two homes never share a vendor client.
  if (propertyId !== 'milano') {
    // Optional targeted push: ?room=<id> processes only that split immediately
    // (a UI target change wants actuation now, not at the next pg_cron tick).
    const onlyRoom = new URL(request.url).searchParams.get('room') ?? undefined;
    return runCampomarinoCycle(propertyId, state, startTime, log, addLog, onlyRoom);
  }

  try {
    // 1. Fetch all data in parallel. Bridge (Homey App → webhook → Supabase)
    // is the ONLY sensor source — the old Athom OAuth cloud client was
    // dropped (never returned data and added ~5s timeout per cycle).
    // Season flag gates automatic actuation: 'off' means the building loop
    // is dead (Milano interregno between 15-apr heating cutoff and chiller
    // activation) — fancoils stay on user's last state, bathrooms go to
    // antifreeze. Fail-safe=heat so a Supabase hiccup doesn't silently
    // disable the agent in winter.
    // Per-promise error catch so a single vendor failure doesn't sink the
    // whole cycle. Each fallback is the empty/safe value: empty devices array,
    // empty bridge map, null outdoor, fail-safe season='heat'.
    const [sabianaDevices, bridgeReadings, outdoorTemp, season] = await Promise.all([
      getValidToken().then(t => getDeviceStates(t)).catch(e => {
        addLog(`Sabiana error: ${e instanceof Error ? e.message : 'unknown'}`);
        return [];
      }),
      loadBridgeReadings().catch(e => {
        addLog(`Bridge error: ${e instanceof Error ? e.message : 'unknown'}`);
        return {};
      }),
      fetchOutdoorTemp(propertyId).catch(() => null),
      loadSeason(propertyId).catch(e => {
        addLog(`Season error: ${e instanceof Error ? e.message : 'unknown'} — fail-safe heat`);
        return 'heat' as const;
      }),
    ]);
    // Load room configs with outdoor compensation (needs outdoorTemp first)
    // and the DB-driven topology (device→room map) in parallel — both are
    // `rooms` reads. The topology replaces the former hardcoded
    // SABIANA_DEVICE_MAP; getRoomForDevice below is a pure O(1) sync Map lookup
    // so every existing synchronous call-site (.filter/.map/.sort comparators)
    // keeps working unchanged. The DB device→room map is byte-identical to the
    // old hardcoded one (verified), so Milano output is unchanged.
    const [ROOM_CONFIG, topology] = await Promise.all([
      loadRoomConfigs(outdoorTemp, propertyId),
      loadTopology({ propertyId }),
    ]);
    const getRoomForDevice = (deviceId: string): string | undefined =>
      topology.deviceToRoom.get(deviceId);

    // Bridge is authoritative. Readings older than 5 min are already filtered
    // out by loadBridgeReadings(). No cloud fallback: an absent room goes to
    // Sabiana T1 gate below, and if that fails too the agent enters
    // SENSOR_FAULT for that room (defensive heat for Nursery).
    const freshReadings: Record<string, { temperature: number; humidity: number }> = {};
    let bridgeUsed = 0;
    for (const [roomId, bridge] of Object.entries(bridgeReadings)) {
      freshReadings[roomId] = { temperature: bridge.temperature, humidity: bridge.humidity ?? 0 };
      bridgeUsed++;
    }
    let fallbackCount = 0;

    // Sanity bounds for Sabiana T1 fallback. The built-in fancoil sensor reads
    // ambient air at the unit and drifts cold (~outdoor temp) when the fancoil
    // is off in winter — readings <16°C or >32°C inside a heated home are
    // physically implausible and unsafe to act on (would trigger aggressive
    // heating in Nursery's room based on a phantom emergency).
    const SABIANA_FALLBACK_MIN = 16;
    const SABIANA_FALLBACK_MAX = 32;
    let fallbackRejected = 0;

    const devices = sabianaDevices.map(d => {
      const roomId = getRoomForDevice(d.deviceId);
      const sonoff = roomId ? freshReadings[roomId] : undefined;
      if (sonoff?.temperature != null) {
        return { ...d, temperature: sonoff.temperature };
      }
      // Fallback: use Sabiana built-in sensor (less accurate, ±1°C, but better than blind)
      if (d.temperature != null && d.connectionUp) {
        if (d.temperature < SABIANA_FALLBACK_MIN || d.temperature > SABIANA_FALLBACK_MAX) {
          fallbackRejected++;
          return { ...d, temperature: null }; // implausible → treat as sensor fault
        }
        fallbackCount++;
        return d; // keep original Sabiana temperature
      }
      return { ...d, temperature: null };
    });

    const totalFresh = Object.keys(freshReadings).length;
    const comp = outdoorCompensation(outdoorTemp);
    let statusMsg = `Cycle #${state.cycleCount} | Outdoor: ${outdoorTemp}°C`;
    if (comp > 0) statusMsg += ` (comp +${comp.toFixed(1)}°C)`;
    statusMsg += ` | Sensors: ${totalFresh}/7 (${bridgeUsed} bridge)`;
    if (fallbackCount > 0) statusMsg += ` | Sabiana fallback: ${fallbackCount}`;
    if (fallbackRejected > 0) statusMsg += ` | Sabiana rejected (out of bounds): ${fallbackRejected}`;
    statusMsg += ` | season=${season}`;
    addLog(statusMsg);

    // Re-arm bathroom-closure bookkeeping: clear the stamp ONLY when the
    // building loop is delivering hot water again (season='heat'). In 'cool'
    // and 'off' the bathroom valves MUST stay forced-closed (7°C, 180-day
    // endtime) — the radiator water is cold (chiller) or absent (interregno),
    // and an open valve in either case condenses bathroom humidity onto the
    // cold radiator body. Mould risk on grout and paint.
    if (season === 'heat' && state.bathroomsAntifrozenAt !== null) {
      state.bathroomsAntifrozenAt = null;
    }
    // Re-arm Smarther-summer-open bookkeeping: clear ONLY when leaving cool.
    // In 'heat' the manageThermostat logic owns the Smarther setpoint and we
    // don't want a stale forever-30°C override interfering with winter
    // boiler-call decisions. In 'off' the building loop is dead so clearing
    // is also safe — next 'cool' transition will re-arm.
    if (season !== 'cool' && state.smartherSummerOpenAt !== null) {
      state.smartherSummerOpenAt = null;
    }
    // Re-arm Smarther-close bookkeeping: clear ONLY when leaving 'off'. The
    // release-to-schedule push (ensureSmartherClosed) should happen once per
    // off-transition; clearing here lets the next 'off' re-arm it cleanly.
    if (season !== 'off' && state.smartherClosedAt !== null) {
      state.smartherClosedAt = null;
    }

    // 2. Save readings — only on meaningful change.
    // Reduces Supabase Disk IO: insertings 5-7 row every 10 min (864-1008 row/day)
    // when temperatures are stable produces ~25k row/month of identical data.
    // We compare each row to the last-saved snapshot held in agent_state.lastReadings
    // and skip writes where temp drift < 0.2°C AND setpoint/fan/mode unchanged.
    // A forced flush every ~30 cycles (~5h) keeps a minimum history density.
    const now = new Date().toISOString();
    const allReadings = devices
      .filter(d => getRoomForDevice(d.deviceId))
      .map(d => ({
        room_id: getRoomForDevice(d.deviceId)!,
        measured_at: now,
        temperature: d.temperature,
        setpoint: d.setpoint,
        fan_speed: d.fanSpeed,
        mode: d.mode,
        heating_active: d.mode === 'heat' && d.temperature !== null && d.temperature < d.setpoint,
        outdoor_temp: outdoorTemp,
      }));
    for (const roomId of ['bagno1', 'bagno2']) {
      const sonoff = freshReadings[roomId];
      if (sonoff?.temperature != null) {
        allReadings.push({
          room_id: roomId,
          measured_at: now,
          temperature: sonoff.temperature,
          setpoint: ROOM_CONFIG[roomId]?.target ?? null,
          fan_speed: null as unknown as number,
          mode: 'heat' as const,
          heating_active: false,
          outdoor_temp: outdoorTemp,
        });
      }
    }
    // Filter: keep only rows that meaningfully differ from last persisted snapshot.
    type Snap = { t: number | null; sp: number | null; fan: number | null; mode: string };
    const lastReadings = (state.lastReadings ?? {}) as Record<string, Snap>;
    const FORCE_FLUSH_EVERY = 30; // cycles. Ensures one row every ~5h for stable rooms.
    const sinceForce = state.cycleCount - (state.lastReadingsFlushCycle ?? 0);
    const forceFlush = sinceForce >= FORCE_FLUSH_EVERY;
    const readings = allReadings.filter(r => {
      if (forceFlush) return true;
      const prev = lastReadings[r.room_id];
      if (!prev) return true;
      const tDelta = (r.temperature ?? 0) - (prev.t ?? 0);
      const tChanged = prev.t === null
        ? r.temperature !== null
        : Math.abs(tDelta) >= 0.2;
      const spChanged = r.setpoint !== prev.sp;
      const fanChanged = r.fan_speed !== prev.fan;
      const modeChanged = r.mode !== prev.mode;
      return tChanged || spChanged || fanChanged || modeChanged;
    });
    if (readings.length > 0) {
      supaInsert('readings', readings).catch(() => {});
      // Update last-saved snapshot for next cycle's diff.
      for (const r of readings) {
        lastReadings[r.room_id] = {
          t: r.temperature,
          sp: r.setpoint,
          fan: r.fan_speed,
          mode: r.mode,
        };
      }
      state.lastReadings = lastReadings;
      if (forceFlush) state.lastReadingsFlushCycle = state.cycleCount;
    }
    addLog(`readings: persisted=${readings.length}/${allReadings.length}${forceFlush ? ' (forced flush)' : ''}`);

    // 3. Thermostat management FIRST (ensures hot water before fancoil commands)
    const heatingRoomIds = new Set<string>();

    // Pre-scan: determine which rooms will be heating this cycle
    const sortedDevices = devices
      .filter(d => getRoomForDevice(d.deviceId))
      .sort((a, b) => {
        const ra = ROOM_CONFIG[getRoomForDevice(a.deviceId)!];
        const rb = ROOM_CONFIG[getRoomForDevice(b.deviceId)!];
        return (ra?.priority || 99) - (rb?.priority || 99);
      });

    // Quick pass to predict actuation states for thermostat decision.
    // In summer (season='cool') the boiler is OFF — thermostat boosting is
    // skipped entirely below, so this pre-scan exists only for winter logic.
    for (const device of sortedDevices) {
      const roomId = getRoomForDevice(device.deviceId)!;
      if (DISABLED_ROOMS.has(roomId)) continue;
      const config = ROOM_CONFIG[roomId];
      if (!config) continue;
      const rs = getRoomState(state, roomId);
      const temp = device.temperature;

      if (season === 'cool') {
        // Summer: a room "actuating" means it's cooling. heatingRoomIds is
        // re-used as the active-actuation set for symmetry, but it does NOT
        // drive the (skipped) thermostat boost in summer.
        if (temp !== null && (rs.controlState === 'COOLING' || temp >= config.offThreshold)) {
          heatingRoomIds.add(roomId);
        }
      } else {
        if (temp !== null && (rs.controlState === 'HEATING' || temp <= config.onThreshold)) {
          heatingRoomIds.add(roomId);
        }
      }

      // COLD-AIR GUARD for critical rooms (Nursery): when the sensor is
      // faulted OR we're already in SENSOR_FAULT state, the later safety
      // branch (checkSafetyInvariants) will command `mode: 'heat'` on the
      // fancoil. If the thermostat has NOT been boosted at that point, the
      // fancoil blows cold/tepid air on the baby. Force the room into
      // heatingRoomIds so manageThermostat raises the Smarther setpoint
      // BEFORE the fancoil command goes out. Winter-only — in summer the
      // boiler is off so this guard is moot.
      if (config.critical && season !== 'cool') {
        const isFaultNow = temp === null && rs.consecutiveNullReadings + 1 >= SENSOR_FAULT_THRESHOLD;
        if (isFaultNow || rs.controlState === 'SENSOR_FAULT') {
          heatingRoomIds.add(roomId);
        }
      }
    }

    // Netatmo-only rooms (bagno1/bagno2): valves open autonomously when cold,
    // so the boiler must be on too — otherwise water stays cold in the radiator
    // and the cold metal surface condenses bathroom humidity. Treat them like
    // any other heating room for the thermostat decision. Winter-only.
    if (season !== 'cool') {
      for (const roomId of ['bagno1', 'bagno2']) {
        if (DISABLED_ROOMS.has(roomId)) continue;
        const config = ROOM_CONFIG[roomId];
        const sonoff = freshReadings[roomId];
        if (!config || sonoff?.temperature == null) continue;
        if (sonoff.temperature <= config.onThreshold) {
          heatingRoomIds.add(roomId);
        }
      }
    }

    let anyCorrection = false;

    if (season === 'off') {
      // GLOBAL OFF — total shutdown. The user flips to 'off' when leaving
      // home (or during the building-loop interregno). Everything goes quiet:
      //   1. Force every fancoil to mode='off' idempotently (re-asserted each
      //      cycle so a unit that drifts back on — manual panel, failed
      //      command, power blip — gets shut down again).
      //   2. Release the Smarther zone-valve override → apartment loop neutral.
      //   3. Push bathroom valves to antifreeze (cold/absent radiator water
      //      would otherwise condense bathroom humidity → mould).
      // No safety re-actuation: per Fabio, season='off' means nobody is home,
      // so we never fire heat/cool. Out-of-bounds rooms still raise an alert
      // (alerts don't actuate hardware), so a real emergency still reaches him.
      const tokenHolder: { token: string | null } = { token: null };
      let offSent = 0, alreadyOff = 0, offRateLimited = 0;
      // Per-room shutdown outcome, fed to the OFF-Milano guard below so it can
      // tell "I just commanded this off (BLE echo race)" from "this unit keeps
      // ignoring the OFF" (a real escape).
      const shutdownResults: Record<string, ShutdownResult> = {};
      for (const device of sortedDevices) {
        const roomId = getRoomForDevice(device.deviceId)!;
        const result = await shutdownRoomOff(
          roomId,
          {
            deviceId: device.deviceId,
            mode: device.mode,
            fanRunning: device.fanRunning,
            setpoint: device.setpoint,
            fanSpeed: device.fanSpeed,
            connectionUp: device.connectionUp,
          },
          state,
          tokenHolder,
        );
        shutdownResults[roomId] = result;
        if (result === 'off_sent') { offSent++; addLog(`${roomId}: OFF (global shutdown)`); }
        else if (result === 'already_off') alreadyOff++;
        else if (result === 'rate_limited') { offRateLimited++; addLog(`${roomId}: OFF pending (rate-limited, retry next cycle)`); }
        else if (result.startsWith('failed:')) addLog(`${roomId}: OFF command ${result}`);
      }
      addLog(`global-off: fancoils off_sent=${offSent} already_off=${alreadyOff}${offRateLimited ? ` rate_limited=${offRateLimited}` : ''}`);

      // OFF-Milano guard: detect a fancoil that has persistently escaped the OFF
      // (failed/ignored command, manual panel switch-on) across multiple cycles
      // and raise a critical alert. Read+alert only — no actuation. Uses the
      // top-of-cycle device states + this cycle's shutdown outcomes; the streak
      // logic absorbs the same-cycle BLE echo race. See off-guard.ts.
      const offGuard = await runOffMilanoGuard(state, {
        devices: sortedDevices,
        roomForDevice: getRoomForDevice,
        shutdownResults,
        sendAlert,
      });
      addLog(offGuard.message);

      // Release the Smarther zone valve (was forced open in summer).
      try {
        const closed = await ensureSmartherClosed(state);
        addLog(`therm: ${closed.reason} (season=off)`);
      } catch (e) {
        addLog(`therm: close error — ${e instanceof Error ? e.message : 'unknown'}`);
      }

      const antifreeze = await ensureBathroomsAntifrozen(state);
      addLog(`antifreeze: ${antifreeze.reason}${antifreeze.rooms.length ? ` rooms=${antifreeze.rooms.join(',')}` : ''}`);

      // Safety-only scan: emit alerts if any room is outside SAFETY_BOUNDS,
      // but DO NOT issue heat/cool commands — the house is intentionally off.
      // SENSOR_FAULT_THRESHOLD (3 cycles ≈ 30 min) is the alert cadence; the
      // state machine is gated in off, so we track Nursery's null-counter here.
      const OFF_SENSOR_ALERT_THRESHOLD = SENSOR_FAULT_THRESHOLD; // 3 cycles ≈ 30 min
      for (const device of sortedDevices) {
        const roomId = getRoomForDevice(device.deviceId)!;
        // Phase 3b: bounds from the DB-sourced config (built above for every
        // room). Preserves the former "room not known → skip" guard. The
        // config's bounds are finite (loadRoomConfigs guarantees it), so an
        // empty/null DB read degrades to the SAFETY_BOUNDS fallback inside the
        // loader rather than silencing this off-season life-safety scan.
        const cfg = ROOM_CONFIG[roomId];
        const safety = cfg ? { min: cfg.safetyMin, max: cfg.safetyMax } : null;
        if (!safety) continue;
        // Nursery life-safety: even in global-off, a SILENT sensor must not go
        // unnoticed (family away, interregno). processRoom never runs in off,
        // so consecutiveNullReadings won't advance there — track it here and
        // alert once the sensor has been dark long enough. No actuation.
        if (device.temperature == null) {
          if (roomId === 'leone') {
            const rs = getRoomState(state, 'leone');
            rs.consecutiveNullReadings++;
            if (rs.consecutiveNullReadings >= OFF_SENSOR_ALERT_THRESHOLD) {
              await sendAlert(
                state,
                'critical',
                `Sensore Nursery non risponde da ${rs.consecutiveNullReadings * 10} min — impianto spento (Off globale), verifica manuale`,
                'leone',
              );
            }
          }
          continue;
        }
        // Nursery reading recovered → reset the null counter.
        if (roomId === 'leone') getRoomState(state, 'leone').consecutiveNullReadings = 0;
        if (device.temperature < safety.min || device.temperature > safety.max) {
          await sendAlert(
            state,
            'critical',
            `${roomId}: ${device.temperature}°C fuori limiti (${safety.min}-${safety.max}°C) — impianto spento (Off globale), intervento manuale`,
            roomId,
          );
        }
      }
    } else {
      // Thermostat boost = make the boiler call for hot water. Only meaningful
      // in winter. In summer the chiller is run by the condominio and the
      // Smarther 2 has no cooling-side authority, so skip entirely.
      if (season === 'heat') {
        try {
          const thermResult = await manageThermostat(state, heatingRoomIds, freshReadings, ROOM_CONFIG);
          addLog(`therm: ${thermResult}`);
        } catch (e) {
          addLog(`Thermostat error: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      } else {
        // season === 'cool'

        // STEP 1: keep the Smarther 2 zone valve OPEN so the chiller's cold
        // water reaches the fancoils. Smarther 2 is heating-mode firmware:
        // it closes the valve when measured > setpoint. We pin it to
        // manual/30°C/180d so it perpetually "wants more heat" → valve
        // stays open → cold water passes through to the fancoils, which
        // then run their own cool control downstream.
        try {
          const open = await ensureSmartherSummerOpen(state);
          addLog(`therm: ${open.reason}${open.setpoint ? ` sp=${open.setpoint}` : ''} (season=cool)`);
        } catch (e) {
          addLog(`therm: open error — ${e instanceof Error ? e.message : 'unknown'}`);
        }

        // STEP 2: bathroom Netatmo valves MUST stay closed. Their radiators
        // carry the same building-loop water, but bathrooms have no
        // fancoil — an open valve drops cold metal into a warm humid room
        // and condenses moisture on the radiator body. Mould risk.
        // Reuse the off-season antifreeze helper: 7°C / 180-day, idempotent
        // via state.bathroomsAntifrozenAt.
        try {
          const closure = await ensureBathroomsAntifrozen(state);
          addLog(`bagni: ${closure.reason}${closure.rooms.length ? ` rooms=${closure.rooms.join(',')}` : ''}`);
        } catch (e) {
          addLog(`bagni close error: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }

      // 4. Control loop — state machine per room
      const tokenHolder: { token: string | null } = { token: null };

      for (const device of sortedDevices) {
        const roomId = getRoomForDevice(device.deviceId)!;
        const config = ROOM_CONFIG[roomId];
        if (!config) continue;

        const { correction } = await processRoom({
          roomId,
          state,
          device: device as ProcessRoomDevice,
          config,
          heatingRoomIds,
          tokenHolder,
          addLog,
          season,
        });
        if (correction) anyCorrection = true;
      }
    }

    // 5. Safety alerts for Netatmo-only rooms
    for (const roomId of ['bagno1', 'bagno2']) {
      const sonoff = freshReadings[roomId];
      if (sonoff?.temperature != null) {
        // Phase 3b: bounds from the DB-sourced config (finite-guarded by the
        // loader). Preserves the former `if (safety && ...)` skip-if-unknown.
        const cfg = ROOM_CONFIG[roomId];
        const safety = cfg ? { min: cfg.safetyMin, max: cfg.safetyMax } : null;
        if (safety && (sonoff.temperature < safety.min || sonoff.temperature > safety.max)) {
          await sendAlert(state, 'critical', `${roomId}: ${sonoff.temperature}°C — fuori limiti (${safety.min}-${safety.max}°C)`, roomId);
        }
      }
    }

    // 5b. Bridge health check (every 5 cycles ≈ 10 min). If no Sonoff
    // readings reached us this cycle, the Homey Advanced Flow is silent —
    // alert the operator. The dedicated /api/health/bridge endpoint covers
    // the short-window case; this is the backup inside the agent cycle.
    if (state.cycleCount % 5 === 0 && bridgeUsed === 0) {
      await sendAlert(state, 'critical',
        `Bridge silent: no Sonoff readings in sonoff_bridge. Check Homey Flow 'thermoleo-bridge-cucina'.`,
        '_bridge');
    }

    // 6. Save state
    state.correcting = anyCorrection;
    state.lastCycleTime = Date.now();
    await saveAgentState(state);

    const elapsed = Date.now() - startTime;
    addLog(`Cycle done in ${elapsed}ms | heating=${heatingRoomIds.size} rooms | correcting=${anyCorrection}`);

    return NextResponse.json({
      ok: true,
      cycle: state.cycleCount,
      elapsed,
      correcting: anyCorrection,
      heating: [...heatingRoomIds],
      log,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown';
    addLog(`FATAL: ${msg}`);
    await saveAgentState(state);
    return NextResponse.json({ ok: false, error: msg, log }, { status: 500 });
  }
}

// pg_cron uses net.http_post
export async function POST(request: Request) {
  return GET(request);
}
