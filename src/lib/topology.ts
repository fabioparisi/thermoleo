/**
 * DB-driven topology — single source of truth for the room/device map.
 *
 * Historically the topology lived in several hardcoded structures
 * (SABIANA_DEVICE_MAP, ROOMS[], plus per-consumer id/device Sets like
 * ALLOWED_DEVICE_IDS, VALID_ROOMS, NETATMO_ROOMS, BATHROOM_ROOMS). They all
 * encode the SAME facts that are already columns on the `rooms` table:
 *   id, name, api_source, device_id, icon, priority.
 * This module loads those rows once and derives every list from them, so a new
 * room (or a second property's rooms) is added as DATA, not a code edit.
 *
 * Scope note (Phase 3a): this covers only the columns that exist on live
 * `rooms` today (id/name/api_source/device_id/icon/priority). The
 * column-dependent moves — SAFETY_BOUNDS → safety_min/max, ROOM_PRIORITIES.
 * critical → critical, fan ladder → fan_profile, thermostat role → role — are
 * Phase 3b, blocked on the Phase 4 migration that adds those columns. Until
 * then SAFETY_BOUNDS/fan/role stay hardcoded (moving them buys Milano nothing
 * and only adds seed-error risk against the byte-identical invariant).
 *
 * Byte-identical guarantee (verified 2026-06-20): the live `rooms.device_id`
 * → `id` mapping is identical to the former hardcoded SABIANA_DEVICE_MAP, so
 * swapping getRoomForDevice to read this map produces the same resolution.
 */

import { supaGet } from '@/lib/supabase/rest';

export type ApiSource = 'sabiana' | 'netatmo' | 'melcloud' | 'shelly_bridge';

/** A topology row as loaded from `rooms` (Phase 3a column subset). */
export interface TopologyRoom {
  id: string;
  name: string;
  api_source: ApiSource;
  device_id: string | null;
  icon: string | null;
  priority: number | null;
}

/** Derived, query-ready view of the topology built from the rows. */
export interface Topology {
  rooms: TopologyRoom[];
  /** deviceId → roomId (only rooms with a device_id). Replaces SABIANA_DEVICE_MAP. */
  deviceToRoom: Map<string, string>;
  /** All known room ids (replaces ALLOWED_ROOM_IDS). */
  roomIds: Set<string>;
  /** Sabiana fancoil device ids (replaces ALLOWED_DEVICE_IDS / ALL_DEVICE_IDS). */
  sabianaDeviceIds: string[];
  /** Netatmo (bathroom) room ids (replaces NETATMO_ROOMS / BATHROOM_ROOMS / BATHROOM_ROOM_KEYS). */
  bathroomRoomIds: Set<string>;
}

const SELECT = 'select=id,name,api_source,device_id,icon,priority';

/** Default property when a caller doesn't specify one (single-home back-compat). */
const DEFAULT_PROPERTY = 'milano';

/**
 * Build the derived view from raw rows. Pure — exported for tests and for
 * callers that already hold the rows.
 */
export function buildTopology(rows: TopologyRoom[]): Topology {
  const deviceToRoom = new Map<string, string>();
  const sabianaDeviceIds: string[] = [];
  const bathroomRoomIds = new Set<string>();
  const roomIds = new Set<string>();

  for (const r of rows) {
    roomIds.add(r.id);
    if (r.device_id) {
      deviceToRoom.set(r.device_id, r.id);
      if (r.api_source === 'sabiana') sabianaDeviceIds.push(r.device_id);
    }
    if (r.api_source === 'netatmo') bathroomRoomIds.add(r.id);
  }

  return { rooms: rows, deviceToRoom, roomIds, sabianaDeviceIds, bathroomRoomIds };
}

// Per-invocation cache, keyed BY PROPERTY. A single module-global (the former
// shape) is a safety landmine the moment loadTopology filters by property: a
// campomarino cycle on a warm Lambda would cache a campomarino-only topology,
// then a milano cycle (or any of the 5 route handlers) within TTL would read it
// → zero Sabiana devices → every Milano fancoil looks absent → no actuation,
// winter, baby home. One entry per propertyId isolates them — same fix as
// season.ts's per-property cache Map (Phase 5).
const cache = new Map<string, { at: number; topology: Topology }>();
const TTL_MS = 60_000;

/**
 * Load the topology for one property from `rooms`, cached per-property for
 * TTL_MS. Throws if the fetch fails (callers decide whether to fail-closed; the
 * cycle already wraps vendor fetches in per-promise catches).
 *
 * @param opts.propertyId  Which property's rooms to load (default 'milano').
 *   The filter + the per-property cache key MUST use the same value so a
 *   second property can never poison the first's topology.
 */
export async function loadTopology(opts?: { force?: boolean; timeout?: number; propertyId?: string }): Promise<Topology> {
  const propertyId = opts?.propertyId ?? DEFAULT_PROPERTY;
  const now = Date.now();
  const hit = cache.get(propertyId);
  if (!opts?.force && hit && now - hit.at < TTL_MS) return hit.topology;
  const rows = await supaGet<TopologyRoom[]>(
    `/rest/v1/rooms?${SELECT}&property_id=eq.${encodeURIComponent(propertyId)}`,
    { timeout: opts?.timeout ?? 8000 },
  );
  const topology = buildTopology(rows);
  cache.set(propertyId, { at: now, topology });
  return topology;
}

/** Test/seam hook — drop one property's cache, or all when no id given. */
export function __resetTopologyCache(propertyId?: string): void {
  if (propertyId) cache.delete(propertyId);
  else cache.clear();
}
