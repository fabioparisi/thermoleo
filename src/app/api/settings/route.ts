import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendCommand } from '@/lib/sabiana/client';
import { getValidToken } from '@/lib/sabiana/token-manager';
import { getDeviceStates } from '@/lib/sabiana/client';
import type { SabianaCommand } from '@/lib/sabiana/types';
import { assertWriteAuth } from '@/lib/auth';
import { parseBody } from '@/lib/http';
import type { Season } from '@/lib/agent/season';
import { __resetSeasonCache } from '@/lib/agent/season';
import type { SeasonOverride } from '@/lib/agent/season-calendar';
import { providerKey } from '@/lib/supabase/rest';
import { loadTopology } from '@/lib/topology';

// The `settings` row is per-property: `settings:milano`, `settings:campomarino`.
// Both READ and WRITE must be property-scoped — a property-blind write here is
// how Milano (empty, must stay OFF) once got flipped to season=cool by a season
// change made on the Campomarino tab. The nude `settings` row was dropped in
// Phase 6, so there is no nude fallback anymore; the suffixed row is the source.
const SETTINGS_PROVIDER = 'settings';
const KNOWN_PROPERTIES = new Set(['milano', 'campomarino']);

/** Resolve + validate the property from the request (default 'milano'). */
function settingsProperty(request: NextRequest): string | null {
  const p = (new URL(request.url).searchParams.get('property') ?? 'milano').toLowerCase();
  return KNOWN_PROPERTIES.has(p) ? p : null;
}

type SettingsData = { season?: unknown; source?: unknown; override?: unknown };

/** Read a property's settings `data` blob (null if absent). */
async function readSettings(propertyId: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('tokens')
    .select('data')
    .eq('provider', providerKey(SETTINGS_PROVIDER, propertyId))
    .maybeSingle();
  if (data) return typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
  return null;
}

/**
 * Write a property's settings `data` blob. UPDATE the suffixed row; on a 0-rows
 * match (row absent — e.g. a brand-new property) bootstrap it with an upsert so
 * the change never silently vanishes. Busts that property's season cache.
 */
async function writeSettings(propertyId: string, data: SettingsData): Promise<boolean> {
  const provider = providerKey(SETTINGS_PROVIDER, propertyId);
  const body = { data, updated_at: new Date().toISOString() };
  const { data: affected, error } = await supabase
    .from('tokens')
    .update(body)
    .eq('provider', provider)
    .select('provider');
  if (error) {
    console.error(`[settings] write ${provider} error:`, error.message);
    return false;
  }
  if (affected && affected.length > 0) {
    __resetSeasonCache(propertyId);
    return true;
  }
  // Row absent → bootstrap it (merge-duplicates on the PK keeps it idempotent).
  const { error: upErr } = await supabase
    .from('tokens')
    .upsert({ provider, ...body }, { onConflict: 'provider' });
  if (upErr) {
    console.error(`[settings] bootstrap ${provider} error:`, upErr.message);
    return false;
  }
  __resetSeasonCache(propertyId);
  return true;
}

// Sabiana fancoil device ids derive from the `rooms` table (Phase 3a) instead
// of a hardcoded list; equivalence pinned by tests/unit/topology.test.ts.

function isSeason(x: unknown): x is Season {
  return x === 'heat' || x === 'cool' || x === 'off';
}

function isISODate(x: unknown): x is string {
  return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
}

function parseOverrideInput(raw: unknown): SeasonOverride | null | 'invalid' {
  // null clears the override.
  if (raw === null) return null;
  if (typeof raw !== 'object' || raw === undefined) return 'invalid';
  const o = raw as Record<string, unknown>;
  if (!isSeason(o.season)) return 'invalid';
  if (!isISODate(o.start) || !isISODate(o.end)) return 'invalid';
  if (typeof o.reason !== 'string' || o.reason.trim().length === 0) return 'invalid';
  if (o.start > o.end) return 'invalid';
  return { season: o.season, start: o.start, end: o.end, reason: o.reason };
}

export async function GET(request: NextRequest) {
  const propertyId = settingsProperty(request);
  if (!propertyId) {
    return NextResponse.json({ ok: false, error: 'unknown_property' }, { status: 400 });
  }
  try {
    const settings = await readSettings(propertyId);

    if (!settings) {
      // Default per property: Milano is the original home (heat default);
      // a brand-new property with no settings row defaults to 'off' (safe — an
      // empty/unconfigured home shouldn't actuate).
      const fallback = propertyId === 'milano' ? 'heat' : 'off';
      return NextResponse.json({ ok: true, season: fallback, source: 'manual', override: null });
    }

    const res = NextResponse.json({
      ok: true,
      season: settings.season ?? 'heat',
      source: settings.source ?? 'manual',
      override: settings.override ?? null,
    });
    // CDN cache varies by the full URL (incl. ?property), so per-property
    // responses don't collide.
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[settings GET] error:', message);
    return NextResponse.json({ ok: false, error: 'settings_read_failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = assertWriteAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: 'forbidden', reason: auth.reason }, { status: 403 });
  }
  const propertyId = settingsProperty(request);
  if (!propertyId) {
    return NextResponse.json({ ok: false, error: 'unknown_property' }, { status: 400 });
  }
  try {
    const parsed = await parseBody(
      request,
      (x): { season?: unknown; override?: unknown; action?: unknown; targetTemp?: unknown } | null => {
        if (typeof x !== 'object' || x === null) return null;
        return x as { season?: unknown; override?: unknown; action?: unknown; targetTemp?: unknown };
      },
    );
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }

    // ── Branch C: apply seasonal defaults (winter or summer) ───────────────
    // Body: { action: 'apply_season_defaults', season: 'heat'|'cool', targetTemp?: number }
    // Copies rooms.target_<season> into rooms.target_temp for every room.
    // If `targetTemp` is provided, first overwrites every room's
    // target_<season> column with that value (used by the UI's "metti tutte
    // a 26°C" button at first summer activation).
    if (parsed.data.action === 'apply_season_defaults') {
      const target = parsed.data.season;
      if (target !== 'heat' && target !== 'cool') {
        return NextResponse.json({ ok: false, error: 'invalid_season' }, { status: 400 });
      }
      const column = target === 'cool' ? 'target_summer' : 'target_winter';

      // Detect whether the dual-target migration (003_room_dual_targets.sql)
      // has been applied. If the per-season column doesn't exist yet, fall
      // back to writing the requested target directly into `target_temp` —
      // the agent will still pick it up, the per-season memory will only
      // start working once the migration runs in production.
      const probe = await supabase
        .from('rooms')
        .select(`id, ${column}`)
        .limit(1);
      const migrationApplied = !probe.error;

      if (parsed.data.targetTemp !== undefined) {
        const tt = parsed.data.targetTemp;
        if (typeof tt !== 'number' || !Number.isFinite(tt) || tt < 15 || tt > 30) {
          return NextResponse.json({ ok: false, error: 'invalid_targetTemp' }, { status: 400 });
        }
        const rounded = Math.round(tt * 2) / 2;
        // PROPERTY-SCOPED: only reset THIS property's rooms. `.neq('id','')`
        // matched ALL rooms across both homes — a "set all to X°C" on one tab
        // would clobber the other property's targets.
        if (migrationApplied) {
          const resetRes = await supabase
            .from('rooms')
            .update({ [column]: rounded, target_temp: rounded })
            .eq('property_id', propertyId);
          if (resetRes.error) {
            console.error('[settings POST defaults] bulk reset failed:', resetRes.error.message);
            return NextResponse.json({ ok: false, error: 'bulk_reset_failed' }, { status: 500 });
          }
        } else {
          // Pre-migration fallback: still seed target_temp so the agent
          // honours the user's intent ("metti tutte a 26").
          const resetRes = await supabase
            .from('rooms')
            .update({ target_temp: rounded })
            .eq('property_id', propertyId);
          if (resetRes.error) {
            console.error('[settings POST defaults] target_temp seed failed:', resetRes.error.message);
            return NextResponse.json({ ok: false, error: 'seed_failed' }, { status: 500 });
          }
        }
      }

      // Copy target_<season> → target_temp. Only meaningful when the dual
      // columns exist — otherwise target_temp IS the single source of truth.
      if (migrationApplied) {
        const { data: roomRows, error: roomsErr } = await supabase
          .from('rooms')
          .select(`id, ${column}`)
          .eq('property_id', propertyId);
        if (roomsErr || !roomRows) {
          // Soft fail: season flag has already been flipped upstream. Caller
          // can re-try defaults later.
          return NextResponse.json({
            ok: true, action: 'apply_season_defaults', season: target,
            warning: 'rooms_read_failed_post_flip',
          });
        }
        for (const row of roomRows as Array<Record<string, unknown>>) {
          const v = row[column];
          if (typeof v === 'number' && Number.isFinite(v)) {
            await supabase.from('rooms').update({ target_temp: v }).eq('id', row.id as string);
          }
        }
      }

      return NextResponse.json({
        ok: true,
        action: 'apply_season_defaults',
        season: target,
        migrationApplied,
      });
    }

    // ── Branch A: override CRUD (when body has `override`) ─────────────────
    if ('override' in parsed.data) {
      const override = parseOverrideInput(parsed.data.override);
      if (override === 'invalid') {
        return NextResponse.json(
          { ok: false, error: 'invalid_override' },
          { status: 400 },
        );
      }

      // Read current to compute the new effective season from the override
      // (or, when clearing, fall back to whatever the next season-tick will
      // resolve — we leave `season` untouched here and let the tick sync it).
      const curData = (await readSettings(propertyId)) ?? {};
      const newSeason: Season = override
        ? override.season
        : (curData.season as Season) ?? 'heat';

      const ok = await writeSettings(propertyId, {
        season: newSeason,
        source: override ? 'override' : 'manual',
        override,
      });
      if (!ok) {
        return NextResponse.json({ ok: false, error: 'db_update_failed' }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        season: newSeason,
        source: override ? 'override' : 'manual',
        override,
      });
    }

    // ── Branch B: direct season set (legacy, fancoil broadcast) ─────────────
    if (!('season' in parsed.data)) {
      return NextResponse.json({ ok: false, error: 'missing_season_or_override' }, { status: 400 });
    }
    const raw = parsed.data.season;
    const season: Season = isSeason(raw) ? raw : 'heat';

    // 1. Update Supabase. Mark as `manual` and CLEAR any active override —
    // a manual season set by the user trumps a still-running override.
    const ok = await writeSettings(propertyId, { season, source: 'manual', override: null });
    if (!ok) {
      return NextResponse.json({ ok: false, error: 'db_update_failed' }, { status: 500 });
    }

    // ── Global OFF: broadcast mode='off' to ALL 5 fancoils immediately ──
    // MILANO ONLY — these are Sabiana fancoils. Campomarino has MELCloud splits
    // (the agent cycle turns those off); broadcasting Sabiana here for a
    // campomarino off would command Milano's hardware for the wrong property.
    if (season === 'off' && propertyId === 'milano') {
      const token = await getValidToken();
      const devices = await getDeviceStates(token);
      const allDeviceIds = (await loadTopology()).sabianaDeviceIds;
      const results: { deviceId: string; success: boolean }[] = [];
      for (const deviceId of allDeviceIds) {
        const device = devices.find((d) => d.deviceId === deviceId);
        const cmd: SabianaCommand = {
          fan: device?.fanSpeed ?? 4,
          mode: 'off',
          temperature: device?.setpoint ?? 22,
          swing: 4,
          preset: 0,
        };
        try {
          results.push({ deviceId, success: await sendCommand(token, deviceId, cmd) });
        } catch {
          results.push({ deviceId, success: false });
        }
      }
      return NextResponse.json({ ok: true, season, source: 'manual', override: null, results });
    }

    // ── Heat / Cool: do NOT broadcast a blanket power-on ──
    // The old code switched ALL 5 fancoils on at fan=4, which (a) ignored the
    // per-room fan ladder (speed by distance-to-target) and (b) turned on
    // rooms already at target that should stay off. Both are the agent's job:
    // its state machine decides, per room, whether to actuate at all and at
    // what fan/setpoint (cool hard-floors the setpoint to safety.min to bypass
    // the T1 bias). Duplicating that here would mean cloning the whole control
    // loop — two ladders that drift out of sync.
    //
    // So we just persist season='heat'|'cool' (done above) and kick the agent
    // cycle right now so the right per-room commands go out within seconds
    // instead of waiting up to 10 min for the next pg_cron tick. The trigger
    // is best-effort: if it times out or fails, the pg_cron schedule is the
    // safety net. The season write already succeeded, so we return ok.
    // cycleTriggered tells the caller whether the immediate kick happened, so
    // a failure shows as "applying…" rather than silently sitting until the
    // next pg_cron tick. We never fail the request on it (the season write is
    // what matters), but we DON'T swallow the reason silently — log it.
    let cycleTriggered = false;
    const secret = process.env.AGENT_CRON_SECRET;
    if (!secret) {
      console.warn('[settings POST] AGENT_CRON_SECRET unset — cannot kick agent cycle; relying on pg_cron (~10 min latency)');
    } else {
      try {
        const origin = new URL(request.url).origin;
        const res = await fetch(`${origin}/api/agent/cycle`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          cycleTriggered = true;
        } else {
          console.warn(`[settings POST] agent cycle kick returned ${res.status}; pg_cron will catch up`);
        }
      } catch (e) {
        console.warn(`[settings POST] agent cycle kick failed: ${e instanceof Error ? e.message : 'unknown'}; pg_cron will catch up`);
      }
    }

    return NextResponse.json({ ok: true, season, source: 'manual', override: null, cycleTriggered });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[settings POST] error:', message);
    return NextResponse.json({ ok: false, error: 'settings_update_failed' }, { status: 500 });
  }
}
