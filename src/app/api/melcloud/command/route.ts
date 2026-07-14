/**
 * Manual MELCloud split command from the UI (campomarino).
 *
 * POST { roomId, power } → turns one split on/off. On power-on it uses the
 * room's current target + mode (dry/cool by gap); a manual OFF holds auto-on 30m.
 * POST { roomId, fan: 1-3|null } → set/clear the PERSISTENT manual fan override
 * (UI wins until changed; null = clear → DEFAULT_FAN). Persists manualFan in
 * agent_state + re-sends immediately if the split is on. The agent stays the
 * brain (it re-evaluates on/off/mode every cycle; only the fan is user-pinned).
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertWriteAuth } from '@/lib/auth';
import { parseBody } from '@/lib/http';
import { supaGet } from '@/lib/supabase/rest';
import type { RoomRow } from '@/lib/supabase/types';
import { listDevices, setAta, getDevice } from '@/lib/melcloud/client';
import { chooseMode, resolveMode, toAbstractFan, SILENT_FAN } from '@/lib/agent/campomarino';
import { loadAgentState, saveAgentState, getRoomState } from '@/lib/agent/state';

/** A manual OFF holds the agent's auto-turn-on for this long. */
const MANUAL_OFF_HOLD_MS = 30 * 60 * 1000; // 30 min (Fabio 2026-06-21)

export async function POST(request: NextRequest) {
  const auth = assertWriteAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: 'forbidden', reason: auth.reason }, { status: 403 });
  }
  const parsed = await parseBody(request, (x): { roomId?: unknown; power?: unknown; fan?: unknown; mode?: unknown } | null =>
    typeof x === 'object' && x !== null ? (x as { roomId?: unknown; power?: unknown; fan?: unknown; mode?: unknown }) : null,
  );
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const { roomId, power, fan, mode } = parsed.data;
  if (typeof roomId !== 'string') {
    return NextResponse.json({ ok: false, error: 'roomId (string) required' }, { status: 400 });
  }
  // Three command shapes (exactly one): { roomId, power:bool } (on/off),
  // { roomId, fan:0-3|null } (manual fan, 0=silent, null=clear→DEFAULT_FAN), or
  // { roomId, mode:'cool'|'dry'|null } (manual mode override, null=clear→auto).
  const isFanCmd = fan !== undefined;
  const isModeCmd = mode !== undefined;
  if (!isFanCmd && !isModeCmd && typeof power !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'power (bool), fan (0-3|null) or mode (cool|dry|null) required' }, { status: 400 });
  }
  // Validate fan: integer 0..3 (0=silent), or null = clear → DEFAULT_FAN.
  let fanValue: number | null = null;
  if (isFanCmd && fan !== null) {
    const f = Number(fan);
    if (!Number.isInteger(f) || f < 0 || f > 3) {
      return NextResponse.json({ ok: false, error: 'fan must be 0-3 (0=silent) or null' }, { status: 400 });
    }
    fanValue = f;
  }
  // Validate mode: 'cool' | 'dry', or null = clear → automatic chooseMode.
  let modeValue: 'cool' | 'dry' | null = null;
  if (isModeCmd && mode !== null) {
    if (mode !== 'cool' && mode !== 'dry') {
      return NextResponse.json({ ok: false, error: "mode must be 'cool', 'dry' or null" }, { status: 400 });
    }
    modeValue = mode;
  }

  try {
    const rows = await supaGet<RoomRow[]>(
      `/rest/v1/rooms?select=id,device_id,target_temp,api_source&id=eq.${encodeURIComponent(roomId)}&limit=1`,
      { timeout: 5000 },
    );
    const room = rows?.[0];
    if (!room || room.api_source !== 'melcloud' || !room.device_id) {
      return NextResponse.json({ ok: false, error: 'not a melcloud room' }, { status: 400 });
    }
    const deviceId = Number(room.device_id);
    if (!Number.isSafeInteger(deviceId)) {
      return NextResponse.json({ ok: false, error: 'invalid device_id' }, { status: 400 });
    }

    const devs = await listDevices();
    const dev = devs.find(d => d.deviceId === deviceId);
    const buildingId = dev?.buildingId ?? 0;

    // ── SET / CLEAR manual fan override (UI wins, permanent until changed) ──
    if (isFanCmd) {
      // Persist the override first (so the UI's choice survives even if the
      // immediate push loses a race with a concurrent cycle). CAS + merge keeps
      // it from being clobbered (mergeSafetyLedgers carries manualFan).
      try {
        const st = await loadAgentState('campomarino');
        const rs = getRoomState(st, roomId);
        rs.manualFan = fanValue; // 0-3 (0=silent), or null = clear → DEFAULT_FAN
        await saveAgentState(st);
      } catch { /* best-effort; next cycle still reads the override if it landed */ }
      // Immediate feedback: if the split is currently ON, re-send with the new
      // fan (single fire-and-forget setAta, no verify loop — the next cycle
      // reconciles). If it's OFF, just persist; the override applies when it
      // next turns on. A clear (null) takes effect on the next actuation.
      if (dev?.power === true && fanValue !== null) {
        const curMode = dev.operationMode === 2 ? 'dry' : dev.operationMode === 1 ? 'heat' : 'cool';
        const sp = typeof dev.setTemperature === 'number' ? dev.setTemperature : Number(room.target_temp);
        // silent (0) in dry dehumidifies almost nothing → bump to slow (1), same
        // guard the agent applies; then map the rung to the client's abstract fan.
        const rung = (curMode === 'dry' && fanValue === SILENT_FAN) ? 1 : fanValue;
        await setAta(deviceId, buildingId, { power: true, mode: curMode, temperature: Number.isFinite(sp) ? sp : 26.5, fan: toAbstractFan(rung) }, dev).catch(() => {});
      }
      return NextResponse.json({ ok: true, roomId, fan: fanValue });
    }

    // ── SET / CLEAR manual mode override (cool/dry; UI wins until cleared) ──
    if (isModeCmd) {
      try {
        const st = await loadAgentState('campomarino');
        const rs = getRoomState(st, roomId);
        rs.manualMode = modeValue; // 'cool'|'dry', or null = clear → automatic
        await saveAgentState(st);
      } catch { /* best-effort; next cycle reads the override if it landed */ }
      // Immediate feedback: if the split is ON, re-send in the new mode now
      // (honouring auto-cool escalation if the room is already hot). If OFF, just
      // persist — the agent applies the mode on the next ON. Clear (null) reverts
      // to automatic on the next actuation.
      if (dev?.power === true && modeValue !== null) {
        const target = Number(room.target_temp);
        const { mode: eff } = resolveMode(modeValue, dev.roomTemperature ?? null, Number.isFinite(target) ? target : null);
        const sp = typeof dev.setTemperature === 'number' ? dev.setTemperature : target;
        await setAta(deviceId, buildingId, { power: true, mode: eff, temperature: Number.isFinite(sp) ? sp : 26.5, fan: 'auto' }, dev).catch(() => {});
      }
      return NextResponse.json({ ok: true, roomId, mode: modeValue });
    }

    if (!power) {
      // ── Manual OFF — must TAKE on the hardware AND survive the agent cycle ──
      // Order matters (board Opus+GLM 2026-06-23): persist the hold BEFORE the
      // setAta(off). Any agent cycle racing this OFF then reads the hold already
      // present → its manual-off early-return fires → it can never setAta(true)
      // in the same window. (CAS+merge(max manualOffUntil) protects the blob; the
      // ordering is what protects the *device* from a concurrent re-on.)
      // We do NOT force controlState='SATISFIED' — the hold is the gate; lying to
      // the FSM (room may be 28°C) is what used to seed a SATISFIED→COOLING re-on.
      let held = false;
      try {
        const st = await loadAgentState('campomarino');
        const rs = getRoomState(st, roomId);
        rs.manualOffUntil = Date.now() + MANUAL_OFF_HOLD_MS;
        await saveAgentState(st);
        held = true;
      } catch { /* hold not persisted — we'll still try the hardware off below */ }

      // Send OFF, then VERIFY it actually took (MELCloud can silently no-op under
      // latency). Mirror the agent's actuate(): read back, retry once, and only
      // report success when the device confirms power=false. The UI must not lie
      // about a baby room's split — on unconfirmed off we return applied:false.
      await setAta(deviceId, buildingId, { power: false, mode: 'off' }, dev).catch(() => {});
      const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
      const isOff = async (): Promise<boolean | null> => {
        try { const f = await getDevice(deviceId, buildingId); return f.power === null ? null : f.power === false; }
        catch { return null; }
      };
      await sleep(2500);
      let off = await isOff();
      if (off === false) {
        await setAta(deviceId, buildingId, { power: false, mode: 'off' }, dev).catch(() => {});
        await sleep(2500);
        off = await isOff();
      }
      if (off === false) {
        // Device refused to turn off. Roll the hold back so the agent isn't muted
        // on a split that's still physically running, and tell the UI the truth.
        if (held) {
          try {
            const st = await loadAgentState('campomarino');
            const rs = getRoomState(st, roomId);
            rs.manualOffUntil = 0;
            await saveAgentState(st);
          } catch { /* best-effort rollback */ }
        }
        return NextResponse.json(
          { ok: false, applied: false, roomId, power: true, error: 'device did not confirm off' },
          { status: 502 },
        );
      }
      // off === true (confirmed) or null (read failed): the OFF was sent and the
      // hold is in place; on a null read the next cycle's off-guard reconciles.
      return NextResponse.json({
        ok: true, applied: off === true, roomId, power: false,
        holdMinutes: MANUAL_OFF_HOLD_MS / 60000,
        ...(off === null ? { unverified: true } : {}),
      });
    }
    // Power on: 'cool' (same rule as the agent, 2026-07-11). A manual ON also
    // clears any lingering manual-off hold.
    const target = Number(room.target_temp);
    const mode = chooseMode();
    await setAta(deviceId, buildingId, { power: true, mode, temperature: Number.isFinite(target) ? target : 26.5, fan: 'auto' }, dev);
    try {
      const st = await loadAgentState('campomarino');
      const rs = getRoomState(st, roomId);
      rs.manualOffUntil = 0;
      rs.controlState = 'COOLING';
      await saveAgentState(st);
    } catch { /* best-effort */ }
    return NextResponse.json({ ok: true, roomId, power: true, mode });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'unknown' }, { status: 500 });
  }
}
