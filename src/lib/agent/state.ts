/**
 * Agent state persistence — stores/loads agent state from Supabase between
 * serverless invocations so the agent can run statelessly on Vercel.
 */

import { providerKey } from '@/lib/supabase/rest';

const PROVIDER = 'agent_state';

interface RoomHistory {
  temp: number;
  timestamp: number;
}

export type ControlState = 'HEATING' | 'COOLING' | 'SATISFIED' | 'SENSOR_FAULT' | 'DISABLED';

export interface RoomState {
  history: RoomHistory[];
  controlState: ControlState;
  lastTransitionCycle: number;
  lastCommandCycle: number;
  commandTimestamps: number[];
  modeChangeTimestamps: number[];
  consecutiveNullReadings: number;
  waterColdCycles: number;
  // OFF-guard escape counter (season=off only): consecutive cycles where the
  // fancoil still reports its fan running DESPITE a shutdown being attempted.
  // A single ON read right after a shutdown command is the BLE echo race, not
  // an escape — only a persistent streak means the OFF truly failed. Monotonic
  // safety ledger: merged by max on a CAS conflict (see mergeSafetyLedgers).
  offGuardStillOnStreak: number;
  lastSetpoint: number | null;
  lastFan: number | null;
  lastMode: string | null;
  // Epoch ms until which a MANUAL OFF (user toggled the split off in the UI)
  // suppresses the agent's auto-turn-on for this room. When the user says "off",
  // the brain must not contradict them for 30 min (Fabio 2026-06-21). Absent/0 =
  // no manual hold. Only the cool/heat ON transition respects it; safety
  // invariants (out-of-bounds for a baby room) still override.
  manualOffUntil?: number;
  // Campomarino: manual fan speed set from the UI. The agent uses this instead
  // of DEFAULT_FAN (1) on every actuation — the UI wins, permanently, until the
  // user changes/clears it. null/absent → DEFAULT_FAN. Cleared on season→off.
  // Ladder space 0-3: 0=silent (MEL 255), 1=slow, 2=mid, 3=fast.
  manualFan?: number | null;
  // Campomarino: manual mode (cool/dry) set from the UI. Wins over the agent's
  // automatic chooseMode — EXCEPT when temp climbs ≥ HARD_COOL_GAP above target,
  // where auto-cool escalation overrides even a manual 'dry' (a baby room must
  // not stay hot because a parent pinned the gentle mode). null/absent → auto.
  // Cleared on season→off. (Fabio 2026-06-23, board Opus+GLM.)
  manualMode?: 'cool' | 'dry' | null;
}

export interface AgentState {
  cycleCount: number;
  roomStates: Record<string, RoomState>;
  originalThermostatSetpoint: number | null;
  lastThermostatCommandTime: number;
  alertCooldowns: Record<string, number>;
  lastCycleTime: number;
  correcting: boolean;
  // Sentinel valve fallback: Smarther 2 isn't a ThermRelay, so when
  // setroomthermpoint fails on the thermostat we pilot the boiler by
  // raising bagno1's valve setpoint (which IS a ThermRelay).
  sentinelActive: boolean;
  lastSentinelCommandTime: number;
  // Offseason bookkeeping. When season flips to 'off' the agent pushes the
  // Netatmo bathroom valves to antifreeze (7°C, long endtime) exactly once
  // per transition; this timestamp marks when that push succeeded so we
  // don't re-hammer the API every cycle. Reset to null on any non-off
  // season read so the next off-transition re-arms.
  bathroomsAntifrozenAt: number | null;
  // Summer Smarther-open bookkeeping. When season flips to 'cool' the agent
  // forces the Smarther 2 zone-valve thermostat to a manual high setpoint
  // (30°C, 180-day endtime) so the valve stays OPEN and the chiller's cold
  // water can reach the fancoils. Set once per cool transition; cleared
  // only when season returns to 'heat'.
  smartherSummerOpenAt: number | null;
  // Global-OFF Smarther-close bookkeeping. When season flips to 'off' the
  // agent releases the Smarther override back to schedule ('home' mode) so
  // the zone valve is no longer forced open — the apartment loop goes neutral.
  // Set once per off transition; cleared on any non-off season read so the
  // next off-transition re-arms.
  smartherClosedAt: number | null;
  // Snapshot of the last persisted reading per room. Used by /api/agent/cycle
  // to skip identical INSERTs and cut Supabase Disk IO. Optional so a fresh
  // agent_state row (or older deploys) gracefully defaults to "write all".
  lastReadings?: Record<string, { t: number | null; sp: number | null; fan: number | null; mode: string }>;
  // Cycle number of the last forced full readings flush. Even when nothing
  // changed we write at least one row every FORCE_FLUSH_EVERY cycles so the
  // history doesn't show fake long gaps.
  lastReadingsFlushCycle?: number;
  // Optimistic-concurrency version. Incremented on every successful save; the
  // save PATCHes only the row whose version still matches the loaded one, so
  // two concurrent cycles can't silently clobber each other (see saveAgentState).
  version?: number;
  // Resolved `tokens.provider` key this state was loaded from (e.g.
  // 'agent_state:milano', or nude 'agent_state' when the suffixed row was
  // absent during the Phase 5→6 drain). NON-PERSISTED: it's the address of the
  // row, not part of its contents, so it MUST be stripped before every write or
  // it round-trips into the `data` JSON. The `_` prefix is a naming convention,
  // NOT a serialization filter — JSON.stringify keeps it. See saveAgentState's
  // explicit `{ _provider, ...rest }` destructure at every write site.
  _provider?: string;
}

const DEFAULT_STATE: AgentState = {
  cycleCount: 0,
  roomStates: {},
  originalThermostatSetpoint: null,
  lastThermostatCommandTime: 0,
  alertCooldowns: {},
  lastCycleTime: 0,
  correcting: false,
  sentinelActive: false,
  lastSentinelCommandTime: 0,
  bathroomsAntifrozenAt: null,
  smartherSummerOpenAt: null,
  smartherClosedAt: null,
};

const DEFAULT_ROOM_STATE: RoomState = {
  history: [],
  controlState: 'HEATING',
  lastTransitionCycle: 0,
  lastCommandCycle: 0,
  commandTimestamps: [],
  modeChangeTimestamps: [],
  consecutiveNullReadings: 0,
  waterColdCycles: 0,
  offGuardStillOnStreak: 0,
  lastSetpoint: null,
  lastFan: null,
  lastMode: null,
};

function supaHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

/** Monotonic version for optimistic concurrency. Lives in AgentState.data so
 *  it travels with the JSON column — no schema migration needed. */
function readVersion(state: AgentState): number {
  const v = (state as AgentState & { version?: unknown }).version;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Read a single `tokens` row by its exact provider key and return its parsed
 * `data` blob (or null on absence / error). The `_provider` stamp is the
 * caller's job — this just fetches.
 */
async function fetchStateRow(provider: string): Promise<AgentState | null> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const res = await fetch(
      `${url}/rest/v1/tokens?provider=eq.${encodeURIComponent(provider)}&select=data`,
      { headers: supaHeaders(), signal: AbortSignal.timeout(10000) },
    );
    const rows = await res.json();
    if (rows?.length && rows[0].data) return rows[0].data as AgentState;
  } catch { /* absent / error → null */ }
  return null;
}

/**
 * Load the agent state for a property.
 *
 * Provider resolution (Phase 5 namespacing + drain-window nude-fallback):
 *   - Read the suffixed key `agent_state:<propertyId>` first.
 *   - If absent, fall back to the nude `agent_state` row (still live until the
 *     Phase 6 drop). `_provider` is stamped with whichever key actually
 *     returned data, so the matching save reads-and-writes the SAME row — no
 *     suffixed/nude split.
 *   - On a total miss (neither row exists), default `_provider` to the SUFFIXED
 *     key so a first-ever save bootstraps the namespaced row, not the nude one.
 *
 * @param opts.exactProvider  Bypass propertyId resolution and read THIS exact
 *   provider key (used by saveAgentState's conflict re-read so the freshness
 *   check hits the very row the CAS targets — see GLM/Opus torn-key finding).
 */
export async function loadAgentState(
  propertyId = 'milano',
  opts?: { exactProvider?: string },
): Promise<AgentState> {
  if (opts?.exactProvider) {
    const data = await fetchStateRow(opts.exactProvider);
    return data
      ? { ...DEFAULT_STATE, ...data, _provider: opts.exactProvider }
      : { ...DEFAULT_STATE, _provider: opts.exactProvider };
  }

  const suffixed = providerKey(PROVIDER, propertyId);
  const suffixedData = await fetchStateRow(suffixed);
  if (suffixedData) return { ...DEFAULT_STATE, ...suffixedData, _provider: suffixed };

  const nudeData = await fetchStateRow(PROVIDER);
  if (nudeData) return { ...DEFAULT_STATE, ...nudeData, _provider: PROVIDER };

  // Total miss → future saves bootstrap the suffixed row.
  return { ...DEFAULT_STATE, _provider: suffixed };
}

/**
 * Merge the append-only / monotonic SAFETY ledgers from the winner's freshly
 * re-read state into ours, so a concurrent cycle's last-write-wins save can't
 * erase them. We do NOT merge the whole object (that would resurrect the
 * winner's stale controlState etc.) — only the fields whose loss is unsafe:
 *   - commandTimestamps / modeChangeTimestamps → union (rate-limit ledgers;
 *     losing them lets the agent exceed the per-hour cap on Nursery's fancoil).
 *   - consecutiveNullReadings → max (SENSOR_FAULT counter; losing it resets
 *     Nursery's sensor-failure detection to zero).
 * Sabiana commands are absolute/idempotent (mode+setpoint+fan), so a double
 * physical command in the load→save window is harmless — verified 2026-06-17.
 */
function mergeSafetyLedgers(ours: AgentState, winner: AgentState): void {
  const oneHourAgo = Date.now() - 3600_000;
  const uniqRecent = (a: number[], b: number[]) =>
    Array.from(new Set([...(a ?? []), ...(b ?? [])])).filter(t => t > oneHourAgo).sort((x, y) => x - y);
  for (const roomId of Object.keys(winner.roomStates ?? {})) {
    const w = winner.roomStates[roomId];
    if (!w) continue;
    const o = getRoomState(ours, roomId);
    o.commandTimestamps = uniqRecent(o.commandTimestamps, w.commandTimestamps);
    o.modeChangeTimestamps = uniqRecent(o.modeChangeTimestamps, w.modeChangeTimestamps);
    o.consecutiveNullReadings = Math.max(o.consecutiveNullReadings ?? 0, w.consecutiveNullReadings ?? 0);
    o.offGuardStillOnStreak = Math.max(o.offGuardStillOnStreak ?? 0, w.offGuardStillOnStreak ?? 0);
    // Manual-off hold is a user intent that must survive a concurrent save —
    // keep the later (max) deadline so a UI OFF isn't erased by a racing cycle.
    o.manualOffUntil = Math.max(o.manualOffUntil ?? 0, w.manualOffUntil ?? 0);
    // Manual fan override: the winner's value wins (the UI command route is the
    // last writer). Without this line a racing cycle save would silently erase a
    // just-set override — the same lost-update class that hit controlState.
    if (w.manualFan !== undefined) o.manualFan = w.manualFan;
    // Manual mode override: same last-writer-wins rule as manualFan, so a UI
    // cool/dry set isn't clobbered by a racing cycle save.
    if (w.manualMode !== undefined) o.manualMode = w.manualMode;
  }
}

/**
 * Optimistic-concurrency save. Two cycles can run at once (pg_cron tick + the
 * cycle the settings POST kicks on a season change). A plain upsert is
 * last-write-wins and silently discards the other cycle's state for ALL rooms.
 * We guard with a version field: PATCH only the row whose version still matches
 * what we loaded; on 0 rows affected, someone else won — re-read, merge the
 * safety ledgers (above), bump version, retry (≤3).
 */
export async function saveAgentState(state: AgentState): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // Read/write the SAME row this state was loaded from. `_provider` is the row
  // address, never part of the persisted contents — strip it from every body.
  const provider = state._provider ?? providerKey(PROVIDER);
  let expectedVersion = readVersion(state);
  for (let attempt = 0; attempt < 3; attempt++) {
    const nextVersion = expectedVersion + 1;
    // Strip `_provider` here so it can't round-trip into `data`. This single
    // destructure feeds BOTH the first PATCH and every retry PATCH (the loop
    // re-enters this line), and the bootstrap POST below reuses `persist` — so
    // all three logical write sites are covered by one strip. (RED round-2 R2.)
    const { _provider, ...persist } = state; void _provider;
    const payload = { ...persist, version: nextVersion };
    try {
      // Conditional update: the WHERE version=eq.<expected> makes this an
      // atomic compare-and-set at Postgres level. return=representation lets
      // us see whether a row actually matched.
      const res = await fetch(
        `${url}/rest/v1/tokens?provider=eq.${encodeURIComponent(provider)}&data->>version=eq.${expectedVersion}`,
        {
          method: 'PATCH',
          headers: { ...supaHeaders(), Prefer: 'return=representation' },
          body: JSON.stringify({ data: payload, updated_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) { console.error(`[state] save failed: ${res.status}`); return; }
      const updated = await res.json().catch(() => []);
      if (Array.isArray(updated) && updated.length > 0) {
        (state as AgentState & { version?: number }).version = nextVersion;
        return; // CAS won
      }
      // 0 rows matched: either a concurrent winner bumped version, or the row
      // doesn't exist yet (first-ever save / version mismatch on a legacy row).
      // Re-read the EXACT same provider key (not a fresh propertyId resolution)
      // so the freshness check and merge operate on the row the CAS targets —
      // otherwise a suffixed/nude split could corrupt the version comparison.
      const fresh = await loadAgentState('milano', { exactProvider: provider });
      const freshVersion = readVersion(fresh);
      if (freshVersion === expectedVersion) {
        // Row absent or legacy (no version field) → bootstrap with an upsert
        // on the SAME provider key.
        await fetch(`${url}/rest/v1/tokens`, {
          method: 'POST',
          headers: { ...supaHeaders(), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ provider, data: { ...persist, version: 1 }, updated_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(10000),
        });
        (state as AgentState & { version?: number }).version = 1;
        return;
      }
      // A concurrent cycle won. Merge its safety ledgers into ours so they
      // aren't lost, retry the CAS against the new version.
      mergeSafetyLedgers(state, fresh);
      expectedVersion = freshVersion;
      console.warn(`[state] save conflict (attempt ${attempt + 1}) — merged safety ledgers, retrying at version ${freshVersion}`);
    } catch (e) {
      console.error('[state] save error:', e instanceof Error ? e.message : e);
      return;
    }
  }
  console.error('[state] save gave up after 3 optimistic-concurrency conflicts');
}

export function getRoomState(state: AgentState, roomId: string): RoomState {
  if (!state.roomStates[roomId]) {
    state.roomStates[roomId] = { ...DEFAULT_ROOM_STATE };
  } else {
    // Schema evolution safety — ensure all fields exist
    const rs = state.roomStates[roomId];
    if (!Array.isArray(rs.history)) rs.history = [];
    if (!Array.isArray(rs.commandTimestamps)) rs.commandTimestamps = [];
    if (!Array.isArray(rs.modeChangeTimestamps)) rs.modeChangeTimestamps = [];
    if (typeof rs.lastCommandCycle !== 'number') rs.lastCommandCycle = 0;
    if (typeof rs.lastTransitionCycle !== 'number') rs.lastTransitionCycle = 0;
    if (typeof rs.consecutiveNullReadings !== 'number') rs.consecutiveNullReadings = 0;
    if (typeof rs.waterColdCycles !== 'number') rs.waterColdCycles = 0;
    if (typeof rs.offGuardStillOnStreak !== 'number') rs.offGuardStillOnStreak = 0;
    if (!rs.controlState) rs.controlState = 'HEATING'; // default for existing state
  }
  return state.roomStates[roomId];
}
