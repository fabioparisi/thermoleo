import { NextResponse } from 'next/server';
import { getDeviceStates } from '@/lib/sabiana/client';
import { getValidToken } from '@/lib/sabiana/token-manager';
import { getHomeStatus, type NetatmoRoom } from '@/lib/netatmo/client';
import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { ROOMS, getRoomForDevice } from '@/lib/rooms';
import { getActiveOverrides, confirmDeviceValues } from '@/lib/setpoint-store';
import { loadBridgeReadingsRaw, loadShellyCampomarino } from '@/lib/bridge';
import { loadAgentState } from '@/lib/agent/state';
import type { RoomStatus } from '@/lib/types';
import type { RoomRow } from '@/lib/supabase/types';
import { supaGet } from '@/lib/supabase/rest';
import { loadNetatmoContext } from '@/lib/netatmo/context';
import type { SabianaMode } from '@/lib/sabiana/types';
import { listDevices as listMelDevices } from '@/lib/melcloud/client';

export const dynamic = 'force-dynamic';

/**
 * Decide the ON/OFF mode shown for a Sabiana fancoil toggle.
 *
 * No single byte tells ON from OFF (see decodeLastData): byte[5] (thermal mode)
 * stays heat/cool even after an OFF command, so it can't distinguish a running
 * unit from one the agent switched off at target. The reliable signal is the
 * fan: an ON Sabiana ALWAYS spins its fan (nibble 0-3), even at target — only
 * OFF parks it idle (verified live). Priority order:
 *
 *   1. fan running (nibble 0-3) → ON. Hard signal — the unit is moving air,
 *      even if switched on from the physical CB-Touch panel. NEVER hide a
 *      fancoil that is actually blowing (matters most for Nursery). Captures
 *      every genuinely-on state because the agent always commands an explicit
 *      fan speed (1-3), never autonomous Auto.
 *   2. explicit off byte (rare) → OFF.
 *   3. pending user override → trust the just-sent command (ON or OFF) until
 *      the device echoes it back.
 *   4. otherwise → OFF. We do NOT infer ON from byte[5] matching the season:
 *      the sticky thermal mode would make every at-target (off) room read ON.
 */
function deriveFancoilMode(
  device: { mode?: SabianaMode; fanRunning?: boolean; storedMode?: SabianaMode } | undefined,
  override: { mode?: string } | undefined,
): SabianaMode {
  // 1. Fan physically running → ON, regardless of season/override/intent.
  //    Hard signal: the unit is moving air (incl. switched on from the
  //    physical CB-Touch panel). Never hide a blowing fancoil — matters for
  //    Nursery. On the Sabiana an ON unit ALWAYS keeps the fan nibble at 0-3
  //    (verified live), even sitting at target; only OFF parks it idle. So
  //    "fan running" captures every genuinely-on state — there is no
  //    "on but fan stopped" case, because the agent always commands an
  //    explicit fan speed (1-3), never leaves the unit in autonomous Auto.
  if (device?.fanRunning) return device.storedMode ?? device.mode ?? 'heat';
  // 2. Explicit off in the byte stream (rare, but honour it if it appears).
  if (device?.mode === 'off') return 'off';
  // 3. Fresh user command not yet echoed by the device — trust the intent.
  //    Covers BOTH a just-sent OFF (don't keep showing the stale thermal mode
  //    as on) and a just-sent ON (show on before the device echoes it).
  if (override?.mode) return override.mode === 'off' ? 'off' : (override.mode as SabianaMode);
  // 4. Fan idle + no pending command → OFF.
  //    We deliberately do NOT infer ON from byte[5] matching the season: the
  //    thermal mode is sticky (an OFF unit keeps its last cool/heat), so a
  //    room the agent has switched off at target still reads 'cool' in summer.
  //    Treating that as ON produced false-ON toggles on every at-target room.
  //    The only real ON states all spin the fan → already returned at (1).
  return 'off';
}

async function fetchNetatmoRooms(): Promise<NetatmoRoom[]> {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return [];

    const { homeId } = await loadNetatmoContext();
    if (!homeId) return [];

    const home = await getHomeStatus(accessToken, homeId);
    return home.rooms || [];
  } catch (e) {
    console.error('Netatmo fetch failed:', e);
    return [];
  }
}

interface RoomTargets {
  current: Record<string, number>;
  winter: Record<string, number>;
  summer: Record<string, number>;
}

async function loadRoomTargets(): Promise<RoomTargets> {
  const empty: RoomTargets = { current: {}, winter: {}, summer: {} };
  // Try the dual-target query first (post-003 migration). If Supabase rejects
  // it because the columns don't exist yet, fall back to the single-target
  // query so the API keeps working before the migration runs.
  try {
    const rows = await supaGet<RoomRow[]>(
      '/rest/v1/rooms?select=id,target_temp,target_winter,target_summer',
      { timeout: 5000 },
    );
    const out: RoomTargets = { current: {}, winter: {}, summer: {} };
    for (const r of rows) {
      out.current[r.id] = Number(r.target_temp);
      if (typeof r.target_winter === 'number') out.winter[r.id] = Number(r.target_winter);
      if (typeof r.target_summer === 'number') out.summer[r.id] = Number(r.target_summer);
    }
    return out;
  } catch {
    try {
      const rows = await supaGet<RoomRow[]>(
        '/rest/v1/rooms?select=id,target_temp',
        { timeout: 5000 },
      );
      const out: RoomTargets = { current: {}, winter: {}, summer: {} };
      for (const r of rows) out.current[r.id] = Number(r.target_temp);
      return out;
    } catch { return empty; }
  }
}

/**
 * Build the room status list for a non-Milano home (campomarino) from MELCloud.
 * Read-only view: the splits' current temp/setpoint/mode, the per-season
 * targets, and the actuation gate. No Sabiana/Netatmo. Kept separate so the
 * Milano GET path stays byte-identical.
 */
async function buildCampomarinoRooms(propertyId: string): Promise<RoomStatus[]> {
  const [rows, mel, shelly, agentState] = await Promise.all([
    supaGet<RoomRow[]>(
      `/rest/v1/rooms?select=id,name,icon,priority,target_temp,target_winter,target_summer,api_source,device_id,actuation_enabled&property_id=eq.${encodeURIComponent(propertyId)}&order=priority`,
      { timeout: 5000 },
    ),
    listMelDevices().catch(() => [] as Awaited<ReturnType<typeof listMelDevices>>),
    // Shelly H&T readings (real room air + humidity), same source the agent uses.
    loadShellyCampomarino().catch((): Record<string, { temperature: number; humidity: number | null }> => ({})),
    // Agent state → manual fan override per room (so the UI reflects the override
    // the agent will apply, not the device's transient SetFanSpeed).
    loadAgentState('campomarino').catch(() => null),
  ]);
  const roomStates = agentState?.roomStates ?? {};
  const byDevice = new Map(mel.map(d => [d.deviceId, d]));
  const out: RoomStatus[] = [];
  for (const r of rows) {
    if (r.api_source !== 'melcloud' || !r.device_id) continue;
    const dev = byDevice.get(Number(r.device_id));
    const powered = dev?.power === true;
    // Temp source = same priority as the agent: Shelly real room air (fresh) >
    // split internal probe (cold return air). Humidity comes only from Shelly.
    const sh = shelly[r.id];
    const rawTemp = sh?.temperature ?? dev?.roomTemperature ?? null;
    const temp =
      rawTemp !== null && Number.isFinite(rawTemp) && rawTemp > 5 && rawTemp < 45
        ? rawTemp
        : null;
    const humidity = sh?.humidity ?? null;
    // Real MELCloud mode so the UI can show "Raffresca"/"Deumidifica"/"Riscalda".
    const melMode = !powered
      ? 'off'
      : dev?.operationMode === 1 ? 'heat'
      : dev?.operationMode === 2 ? 'dry'
      : 'cool';
    out.push({
      roomId: r.id,
      name: r.name ?? r.id,
      icon: r.icon ?? '❄️',
      temperature: temp,
      // When off, the device's last SetTemperature can be a stale/odd value
      // (e.g. 24 = a leaked winter target); show the room's actual target so the
      // card isn't misleading. When running, show what the split is set to.
      setpoint: powered ? (dev?.setTemperature ?? null) : Number(r.target_temp),
      humidity,
      // Show the manual fan override (what the agent will apply) if set; else the
      // device's reported fan (often null from ListDevices). null → UI default 1.
      fanSpeed: roomStates[r.id]?.manualFan ?? dev?.fanSpeed ?? null,
      mode: melMode,
      // The user's manual mode pin (cool/dry) so the selector shows the active
      // choice; null → the agent picks automatically (selector in "auto" state).
      manualMode: roomStates[r.id]?.manualMode ?? null,
      connectionUp: dev !== undefined,
      apiSource: 'melcloud',
      priority: typeof r.priority === 'number' ? r.priority : 99,
      targetTemp: Number(r.target_temp),
      targetWinter: typeof r.target_winter === 'number' ? r.target_winter : null,
      targetSummer: typeof r.target_summer === 'number' ? r.target_summer : null,
      hasFanControl: true,
      deviceId: r.device_id,
      deviceTemp: temp,
      tempSource: temp != null ? 'device' : null,
      propertyId,
      actuationEnabled: r.actuation_enabled === true,
    });
  }
  return out;
}

export async function GET(request: Request) {
  // Property dispatch: campomarino (and any future non-Milano home) renders a
  // separate MELCloud-only view. Default 'milano' keeps the existing UI call
  // (no ?property) byte-identical. Unknown property → 400 (never silent).
  const propertyId = (new URL(request.url).searchParams.get('property') ?? 'milano').toLowerCase();
  if (propertyId !== 'milano' && propertyId !== 'campomarino') {
    return NextResponse.json({ ok: false, error: 'unknown_property', property: propertyId }, { status: 400 });
  }
  if (propertyId === 'campomarino') {
    try {
      const rooms = await buildCampomarinoRooms(propertyId);
      const res = NextResponse.json({ ok: true, rooms, thermostat: null, property: propertyId, timestamp: new Date().toISOString() });
      res.headers.set('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=20');
      return res;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json({ ok: false, error: message, property: propertyId }, { status: 500 });
    }
  }

  try {
    // Fetch all data in parallel
    const [sabianaResult, netatmoRooms, netatmoRoomMap, overrides, bridge, dbTargets] = await Promise.all([
      getValidToken().then(getDeviceStates).catch((e) => {
        console.error('Sabiana fetch failed:', e);
        return [] as Awaited<ReturnType<typeof getDeviceStates>>;
      }),
      fetchNetatmoRooms(),
      loadNetatmoContext().then(ctx => ctx.roomMap ?? {}),
      getActiveOverrides(),
      loadBridgeReadingsRaw(),
      loadRoomTargets(),
    ]);
    const sabianaStates = sabianaResult;

    // Build room status list
    const roomStatuses: RoomStatus[] = ROOMS.map((room) => {
      if (room.apiSource === 'sabiana') {
        const device = sabianaStates.find(
          (s) => getRoomForDevice(s.deviceId) === room.id,
        );
        const override = overrides[room.id];
        const sensor = bridge[room.id];
        const deviceTemp = device?.connectionUp ? (device.temperature ?? null) : null;
        // Only surface the bridge temperature when it's fresh. Stale readings
        // are hidden so the UI renders '--' with a "bridge stale" indicator
        // instead of silently showing an old number that looks live.
        const freshTemp = sensor && !sensor.stale ? sensor.temperature : null;
        const freshHumidity = sensor && !sensor.stale ? sensor.humidity : null;
        return {
          roomId: room.id,
          name: room.name,
          icon: room.icon,
          // Sonoff bridge is the source of truth. The built-in Sabiana T1
          // sensor drifts to random junk values when the fancoil is off, so
          // we never surface it in the UI — null is honest.
          temperature: freshTemp,
          setpoint: override?.setpoint ?? device?.setpoint ?? null,
          humidity: freshHumidity,
          fanSpeed: override?.fan ?? device?.fanSpeed ?? null,
          fanSpeedRaw: device?.fanSpeedRaw ?? null,
          mode: deriveFancoilMode(device, override),
          connectionUp: device?.connectionUp ?? false,
          apiSource: room.apiSource,
          priority: room.priority,
          targetTemp: dbTargets.current[room.id] ?? room.targetTemp,
          targetWinter: dbTargets.winter[room.id] ?? null,
          targetSummer: dbTargets.summer[room.id] ?? null,
          hasFanControl: room.hasFanControl,
          deviceId: device?.deviceId,
          deviceTemp,
          tempSource: freshTemp != null ? 'sonoff' : null,
          bridgeUpdatedAt: sensor?.updatedAt ?? null,
          bridgeAgeMs: sensor ? sensor.ageMs : null,
          bridgeStale: sensor ? sensor.stale : true,
        };
      }

      // Netatmo rooms — find matching room by mapping or name
      const netatmoRoomId = netatmoRoomMap[room.id];
      const netatmoRoom = netatmoRoomId
        ? netatmoRooms.find((nr) => String(nr.id) === netatmoRoomId)
        : undefined;

      const hasData = netatmoRoom && netatmoRoom.therm_measured_temperature !== undefined;

      const override = overrides[room.id];
      const sensor = bridge[room.id];
      const deviceTemp = hasData ? (netatmoRoom?.therm_measured_temperature ?? null) : null;
      // Only use a fresh bridge reading. When stale, fall through to the
      // Netatmo valve sensor which is a real ambient probe (unlike Sabiana T1).
      const freshBridgeTemp = sensor && !sensor.stale ? sensor.temperature : null;
      const freshBridgeHumidity = sensor && !sensor.stale ? sensor.humidity : null;
      const finalTemp = freshBridgeTemp ?? deviceTemp;
      return {
        roomId: room.id,
        name: room.name,
        icon: room.icon,
        // Prefer fresh Sonoff bridge. Netatmo valve sensor is an acceptable
        // fallback for bathrooms since it's a real sensor (not a drifting
        // fancoil return-air probe like Sabiana T1).
        temperature: finalTemp,
        setpoint: override?.setpoint ?? netatmoRoom?.therm_setpoint_temperature ?? null,
        humidity: freshBridgeHumidity,
        fanSpeed: null,
        fanSpeedRaw: null,
        mode: netatmoRoom?.therm_setpoint_mode || 'heat',
        connectionUp: hasData ?? false,
        apiSource: room.apiSource,
        priority: room.priority,
        targetTemp: dbTargets.current[room.id] ?? room.targetTemp,
          targetWinter: dbTargets.winter[room.id] ?? null,
          targetSummer: dbTargets.summer[room.id] ?? null,
        hasFanControl: room.hasFanControl,
        netatmoRoomId,
        deviceTemp,
        tempSource: freshBridgeTemp != null ? 'sonoff' : (deviceTemp != null ? 'device' : null),
        // Netatmo valve heating status
        heatingPowerRequest: netatmoRoom?.heating_power_request ?? null,
        bridgeUpdatedAt: sensor?.updatedAt ?? null,
        bridgeAgeMs: sensor ? sensor.ageMs : null,
        bridgeStale: sensor ? sensor.stale : true,
      };
    });

    // Keep ROOMS array order (Nursery first, then as defined in rooms.ts)
    const roomOrder = ROOMS.map(r => r.id);
    roomStatuses.sort((a, b) => roomOrder.indexOf(a.roomId) - roomOrder.indexOf(b.roomId));

    // Extract Smarther 2 / Termostato Zona data (Netatmo room mapped as 'soggiorno' in room map)
    const thermostatNetatmoId = netatmoRoomMap['soggiorno'] || netatmoRoomMap['termostato'];
    const thermostatRoom = thermostatNetatmoId
      ? netatmoRooms.find((nr) => String(nr.id) === thermostatNetatmoId)
      : undefined;

    // Auto-confirm overrides where device now reports the same setpoint
    const confirmedRooms: string[] = [];
    for (const room of ROOMS) {
      const override = overrides[room.id];
      if (!override) continue;

      if (room.apiSource === 'sabiana') {
        const device = sabianaStates.find(s => getRoomForDevice(s.deviceId) === room.id);
        if (device?.setpoint != null && Math.abs(device.setpoint - override.setpoint) < 0.1) {
          confirmedRooms.push(room.id);
        }
      } else {
        const nrId = netatmoRoomMap[room.id];
        const nr = nrId ? netatmoRooms.find(r => String(r.id) === nrId) : undefined;
        if (nr?.therm_setpoint_temperature != null &&
            Math.abs(nr.therm_setpoint_temperature - override.setpoint) < 0.1) {
          confirmedRooms.push(room.id);
        }
      }
    }
    // Also check thermostat override
    if (overrides['_thermostat'] && thermostatRoom?.therm_setpoint_temperature != null) {
      if (Math.abs(thermostatRoom.therm_setpoint_temperature - overrides['_thermostat'].setpoint) < 0.1) {
        confirmedRooms.push('_thermostat');
      }
    }
    // Fire-and-forget cleanup of confirmed overrides
    if (confirmedRooms.length > 0) {
      confirmDeviceValues(confirmedRooms).catch(e => console.error('[rooms] confirmDeviceValues error:', e));
    }

    const thermOverride = overrides['_thermostat'];
    const soglSonoff = bridge['soggiorno'];
    const freshSogl = soglSonoff && !soglSonoff.stale ? soglSonoff : null;
    const thermDeviceTemp = thermostatRoom?.therm_measured_temperature ?? null;
    const res = NextResponse.json({
      ok: true,
      property: 'milano', // echo so the client can drop a stale reply that
                          // lands after the user switched homes (race guard)
      rooms: roomStatuses,
      thermostat: thermostatRoom ? {
        // Prefer fresh Sonoff; fall back to Smarther 2 built-in sensor (real probe).
        temperature: freshSogl?.temperature ?? thermDeviceTemp,
        setpoint: thermOverride?.setpoint ?? thermostatRoom.therm_setpoint_temperature ?? null,
        humidity: freshSogl?.humidity ?? null,
        mode: thermostatRoom.therm_setpoint_mode ?? null,
      } : null,
      timestamp: new Date().toISOString(),
    });
    // CDN cache: shorter than before to ensure bridge staleness surfaces
    // within ~30s instead of ~60. Still cheap on Vercel.
    res.headers.set('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=20');
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
