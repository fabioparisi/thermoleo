/**
 * Typed row interfaces for ThermoLeo Supabase tables.
 *
 * These match the actual columns accessed via `fetch(.../rest/v1/<table>...)` calls
 * throughout the codebase. They are NOT generated — they are hand-curated from usage.
 * Column names follow the Supabase convention (snake_case).
 */

// ─── rooms ────────────────────────────────────────────────────────────────────

/** A row from the `rooms` table. */
export interface RoomRow {
  id: string;
  /** Display name + icon + UI-sort priority (selected by the rooms API for the
   *  campomarino view; the Milano cycle uses the hardcoded catalog). */
  name?: string;
  icon?: string | null;
  priority?: number | null;
  target_temp: number;
  /** Persisted winter heating target — survives season flips. */
  target_winter?: number;
  /** Persisted summer cooling target — survives season flips. */
  target_summer?: number;
  /** Phase 3b — life-safety bounds (migration 004). Optional/nullable so the
   *  loader's Number.isFinite guard can fall back to the SAFETY_BOUNDS constant
   *  on a malformed or pre-004 row. */
  safety_min?: number | null;
  safety_max?: number | null;
  /** Phase 3b — life-safety priority flag (migration 004). Replaces the
   *  hardcoded ROOM_PRIORITIES.critical reader. Nullable so the loader can fall
   *  back to the constant on a pre-004 row. NOTE: the `priority` *tier* stays
   *  hardcoded (ROOM_PRIORITIES) — the existing rooms.priority column encodes a
   *  different (UI-sort) scheme and must NOT be reused for it. */
  critical?: boolean | null;
  /** Phase 3b — fan ladder selector (migration 004): 'silent' (camera) or
   *  'standard'. Replaces the `roomId === 'camera'` branch. Nullable → loader
   *  defaults to 'standard' (the safe/louder ladder). */
  fan_profile?: string | null;
  /** Phase 7/8 — which vendor cloud drives this room ('sabiana'|'netatmo'|
   *  'melcloud'|'shelly_bridge'). The cycle branches actuation on this. */
  api_source?: string;
  /** Phase 7/8 — vendor device id (TEXT in DB even for numeric MELCloud ids). */
  device_id?: string | null;
  /** Phase 8 — actuation gate (migration 004). The agent reads/logs a room
   *  regardless, but only sends a command when this is TRUE. Campomarino rooms
   *  ship false until each room's independent sensor is validated. The loader
   *  must treat a missing/non-true value as FALSE (fail closed). */
  actuation_enabled?: boolean | null;
  /** Phase 4 — which home this room belongs to (migration 004, default 'milano'). */
  property_id?: string;
}

// ─── readings ─────────────────────────────────────────────────────────────────

/** A row inserted into the `readings` table by the agent cycle. */
export interface ReadingInsert {
  room_id: string | undefined;
  measured_at: string;
  temperature: number | null;
  setpoint: number | null;
  fan_speed: number | null;
  mode: string;
  heating_active: boolean;
  outdoor_temp: number | null;
}

// ─── tokens ───────────────────────────────────────────────────────────────────

/**
 * A row from the `tokens` table.
 * The `data` column is a JSON blob whose shape depends on `provider`.
 */
export interface TokenRow<TData = unknown> {
  provider: string;
  data: TData;
  updated_at?: string;
}

/** Shape of `data` when `provider = 'netatmo_home'` */
export interface NetatmoHomeData {
  home_id: string;
  home_name?: string;
  rooms?: Array<{ id: string; name: string }>;
}

/** Shape of `data` when `provider = 'netatmo_room_map'` */
export type NetatmoRoomMapData = Record<string, string>;

/** Shape of `data` when `provider = 'agent_state'` */
// (AgentState is imported elsewhere; this alias keeps the table contract explicit)
export type AgentStateData = Record<string, unknown>;

/** Shape of `data` when `provider = 'setpoint_overrides'` */
export type SetpointOverridesData = Record<string, unknown>;

// ─── agent_actions ────────────────────────────────────────────────────────────

/** A row inserted into the `agent_actions` table. */
export interface AgentActionInsert {
  room_id: string;
  action_type: string;
  old_value: string | null;
  new_value: string;
  reason: string;
}

// ─── alerts ───────────────────────────────────────────────────────────────────

/** A row inserted into the `alerts` table. */
export interface AlertInsert {
  room_id: string;
  severity: string;
  message: string;
  created_at: string;
}

/** A row read back from the `alerts` table (for debounce queries). */
export interface AlertRow {
  room_id: string;
  severity: string;
  message: string;
  created_at: string;
}

// ─── sonoff_bridge ────────────────────────────────────────────────────────────

/** A row from the `sonoff_bridge` table (as returned by Supabase REST). */
export interface SonoffBridgeRow {
  room_id: string;
  temperature: number | string; // Supabase may return numeric or string depending on column type
  humidity: number | string | null;
  updated_at: string | null;
}

/** A row upserted into the `sonoff_bridge` table by the ingest endpoint. */
export interface SonoffBridgeUpsert {
  room_id: string;
  temperature: number;
  humidity: number | null;
  updated_at: string;
}
