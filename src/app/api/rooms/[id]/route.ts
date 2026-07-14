import { NextResponse } from 'next/server';
import { setRoomState } from '@/lib/netatmo/client';
import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { assertWriteAuth } from '@/lib/auth';
import { supaHeaders, supaUrl, supaInsert } from '@/lib/supabase/rest';
import { loadNetatmoContext } from '@/lib/netatmo/context';
import { loadSeason } from '@/lib/agent/season';
import type { AgentActionInsert } from '@/lib/supabase/types';
import { loadTopology } from '@/lib/topology';

export const dynamic = 'force-dynamic';

// Valid room ids and the Netatmo (bathroom) subset derive from the `rooms`
// table (Phase 3a); equivalence pinned by tests/unit/topology.test.ts.

/**
 * Push a target change to the physical Netatmo valve so the setpoint shown
 * in ThermoLeo matches what the valve actually opens for. Without this, the
 * UI and the DB would say "target 22°C" while the valve still follows its
 * own internal setpoint configured in the BTicino app — silent drift.
 * Failures are logged but do not block the response: the agent cycle will
 * still use the DB target to drive thermostat boost decisions.
 */
async function syncNetatmoValveTarget(roomId: string, targetTemp: number): Promise<{ synced: boolean; reason?: string }> {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return { synced: false, reason: 'no_netatmo_token' };

    const { homeId, roomMap } = await loadNetatmoContext();
    const netatmoRoomId = roomMap?.[roomId];
    if (!homeId || !netatmoRoomId) return { synced: false, reason: 'netatmo_mapping_missing' };

    // 12h window: long enough to cover Fabio's typical day, short enough that
    // a forgotten manual override self-heals overnight.
    const endtime = Math.floor(Date.now() / 1000) + 12 * 3600;
    await setRoomState(accessToken, homeId, String(netatmoRoomId), 'manual', targetTemp, endtime);
    return { synced: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.error(`[rooms PATCH] Netatmo sync failed for ${roomId}:`, reason);
    return { synced: false, reason };
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = assertWriteAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden', reason: auth.reason }, { status: 403 });
  }

  const { id } = await params;
  // Property-aware: a campomarino room (campomarino_*) lives in a different
  // property slice than Milano. Load THAT property's topology/season, or the
  // PATCH 400s on "unknown room id" and the target never persists. (Fabio hit
  // exactly this: a campomarino target edit silently didn't save.)
  const roomProperty = id.startsWith('campomarino') ? 'campomarino' : 'milano';
  const topology = await loadTopology({ propertyId: roomProperty });
  if (!topology.roomIds.has(id)) {
    return NextResponse.json({ error: 'unknown room id' }, { status: 400 });
  }

  let body: { targetTemp?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const { targetTemp } = body;

  if (typeof targetTemp !== 'number' || !Number.isFinite(targetTemp) || targetTemp < 15 || targetTemp > 30) {
    return NextResponse.json({ error: 'targetTemp must be 15-30' }, { status: 400 });
  }

  const rounded = Math.round(targetTemp * 2) / 2; // 0.5°C step

  // Persist the new target into BOTH the active `target_temp` column AND the
  // season-matching column (`target_winter` or `target_summer`) so a season
  // flip later restores the user's edit, not the seed default. Falls back
  // gracefully if the per-season columns don't exist yet (pre-003 migration):
  // first PATCH attempts with the season column, second PATCH without if the
  // first returned a "column does not exist" 4xx.
  const season = await loadSeason(roomProperty).catch(() => 'heat' as const);
  const seasonColumn = season === 'cool' ? 'target_summer' : 'target_winter';

  async function writeBody(body: Record<string, number>) {
    return fetch(`${supaUrl()}/rest/v1/rooms?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...supaHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }

  let res = await writeBody({ target_temp: rounded, [seasonColumn]: rounded });
  if (!res.ok && res.status === 400) {
    // Probable schema-cache 'column does not exist' — retry single-column.
    const text = await res.text().catch(() => '');
    if (text.includes('target_winter') || text.includes('target_summer') || text.includes('PGRST204')) {
      console.warn(`[rooms PATCH] dual-target columns missing, falling back to target_temp only`);
      res = await writeBody({ target_temp: rounded });
    }
  }

  if (!res.ok) {
    // Log detail server-side only; never echo raw Supabase body to caller.
    const text = await res.text().catch(() => '');
    console.error(`[rooms PATCH] DB update failed for ${id}: ${res.status} ${text.slice(0, 200)}`);
    return NextResponse.json({ error: 'db_update_failed', status: res.status }, { status: 500 });
  }

  // If this is a Netatmo valve room (bathrooms), push the new setpoint to the
  // physical valve so it actually opens at the right temperature. Sabiana
  // rooms are driven by the agent cycle separately — no Netatmo push needed.
  let netatmoSync: { synced: boolean; reason?: string } | null = null;
  if (topology.bathroomRoomIds.has(id)) {
    netatmoSync = await syncNetatmoValveTarget(id, rounded);
  }

  // Campomarino splits: don't make the user wait up to 5 min for the next
  // pg_cron — trigger the agent NOW, scoped to JUST this room (?room=<id>), so
  // the split re-evaluates against the new target and actuates immediately.
  // await it so the response reflects a real attempt; failure is non-fatal (the
  // target is saved, the next pg_cron reconciles). (Fabio + board Opus+GLM
  // 2026-06-23: push-on-target, single-room scope to avoid the full-cycle race.)
  let immediatePush: { triggered: boolean; reason?: string } | null = null;
  if (roomProperty === 'campomarino') {
    try {
      const secret = process.env.AGENT_CRON_SECRET;
      if (!secret) {
        immediatePush = { triggered: false, reason: 'no_cron_secret' };
      } else {
        const origin = new URL(request.url).origin;
        const res = await fetch(
          `${origin}/api/agent/cycle?property=campomarino&room=${encodeURIComponent(id)}`,
          { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(45000) },
        );
        immediatePush = { triggered: res.ok, ...(res.ok ? {} : { reason: `cycle_${res.status}` }) };
      }
    } catch (e) {
      immediatePush = { triggered: false, reason: e instanceof Error ? e.message : 'unknown' };
    }
  }

  // Log target change to agent_actions (must await — Vercel kills lambda after response)
  await supaInsert<AgentActionInsert>('agent_actions', [{
    room_id: id,
    action_type: 'target_change',
    old_value: null,
    new_value: String(rounded),
    reason: netatmoSync
      ? `User set target to ${rounded}°C from dashboard (netatmo_sync=${netatmoSync.synced}${netatmoSync.reason ? ' ' + netatmoSync.reason : ''})`
      : `User set target to ${rounded}°C from dashboard`,
  }]).catch(() => {});

  return NextResponse.json({
    ok: true,
    targetTemp: rounded,
    ...(netatmoSync ? { netatmoSync } : {}),
    ...(immediatePush ? { immediatePush } : {}),
  });
}
