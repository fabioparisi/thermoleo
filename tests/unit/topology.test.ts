/**
 * Equivalence guard for the DB-driven topology (Phase 3a).
 *
 * Phase 3a swaps several hardcoded structures for `loadTopology()` derivations
 * while keeping a few hardcoded readers alive (rooms.ts getRoomForDevice in the
 * status/command display routes). That parallel-reader situation is only safe
 * AS LONG AS the DB-derived view stays equal to the old constants. This test is
 * the license: if they ever diverge, CI fails here instead of a Milano response
 * silently drifting in prod.
 *
 * FIXTURE provenance: TOPOLOGY_ROWS mirrors the live `rooms` table captured
 * 2026-06-20 (id/name/api_source/device_id/icon/priority). The live device→room
 * map was verified identical to SABIANA_DEVICE_MAP at that time; this test pins
 * that the buildTopology() derivation reproduces every old hardcoded structure.
 */
import { describe, it, expect } from 'vitest';
import { buildTopology, type TopologyRoom } from '../../src/lib/topology';
import { SABIANA_DEVICE_MAP } from '../../src/lib/rooms';

// Mirrors live `rooms` (Phase 3a column subset). Keep in sync with the DB; the
// equivalence assertions below catch a drift between this fixture and the old
// hardcoded constants, and the comment block documents the live-DB check.
const TOPOLOGY_ROWS: TopologyRoom[] = [
  { id: 'leone',     name: 'Camera Nursery',   api_source: 'sabiana', device_id: 'swm-5443B26CD582', icon: '👶', priority: 1 },
  { id: 'soggiorno', name: 'Soggiorno',      api_source: 'sabiana', device_id: 'swm-24DCC3FCF49E', icon: '🛋️', priority: 0 },
  { id: 'camera',    name: 'Camera da letto', api_source: 'sabiana', device_id: 'swm-0C8B953686CE', icon: '🛏️', priority: 0 },
  { id: 'studio',    name: 'Studio Fabio',   api_source: 'sabiana', device_id: 'swm-3CE90EA38D06', icon: '💻', priority: 0 },
  { id: 'cucina',    name: 'Cucina',         api_source: 'sabiana', device_id: 'swm-3CE90EA00D82', icon: '🍳', priority: 0 },
  { id: 'bagno1',    name: 'Bagno Grande',   api_source: 'netatmo', device_id: null,               icon: '🚿', priority: 0 },
  { id: 'bagno2',    name: 'Bagno Piccolo',  api_source: 'netatmo', device_id: null,               icon: '🛁', priority: 0 },
];

// The hardcoded constants 3a's converted consumers used to carry, inlined here
// as the equivalence target (each is being replaced by a topology derivation).
const OLD_ALLOWED_DEVICE_IDS = new Set([
  'swm-5443B26CD582', 'swm-24DCC3FCF49E', 'swm-0C8B953686CE', 'swm-3CE90EA38D06', 'swm-3CE90EA00D82',
]);
const OLD_ALLOWED_ROOM_IDS = new Set(['leone', 'soggiorno', 'camera', 'studio', 'cucina', 'bagno1', 'bagno2']);
const OLD_VALID_ROOMS = new Set(['leone', 'studio', 'camera', 'soggiorno', 'cucina', 'bagno1', 'bagno2']);
const OLD_NETATMO_ROOMS = new Set(['bagno1', 'bagno2']);

describe('buildTopology equivalence with the old hardcoded structures', () => {
  const topo = buildTopology(TOPOLOGY_ROWS);

  it('deviceToRoom equals the old SABIANA_DEVICE_MAP', () => {
    const asObj = Object.fromEntries(topo.deviceToRoom);
    expect(asObj).toEqual(SABIANA_DEVICE_MAP);
  });

  it('sabianaDeviceIds set-equals ALLOWED_DEVICE_IDS / ALL_DEVICE_IDS', () => {
    expect(new Set(topo.sabianaDeviceIds)).toEqual(OLD_ALLOWED_DEVICE_IDS);
  });

  it('roomIds equals ALLOWED_ROOM_IDS (and VALID_ROOMS — same set)', () => {
    expect(topo.roomIds).toEqual(OLD_ALLOWED_ROOM_IDS);
    expect(topo.roomIds).toEqual(OLD_VALID_ROOMS); // VALID_ROOMS is the same set, different literal order
  });

  it('bathroomRoomIds equals NETATMO_ROOMS / BATHROOM_ROOMS', () => {
    expect(topo.bathroomRoomIds).toEqual(OLD_NETATMO_ROOMS);
  });

  it('every sabiana room has a device_id; every netatmo room (bathroom) has none', () => {
    for (const r of TOPOLOGY_ROWS) {
      if (r.api_source === 'sabiana') expect(r.device_id).toBeTruthy();
      if (r.api_source === 'netatmo') expect(r.device_id).toBeNull();
    }
  });
});
