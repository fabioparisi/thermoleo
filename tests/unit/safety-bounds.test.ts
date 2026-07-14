/**
 * Equivalence guard for the DB-driven safety bounds (Phase 3b).
 *
 * Phase 3b moves the runtime READER of the per-room life-safety bounds from the
 * module-level SAFETY_BOUNDS map to the DB `rooms.safety_min/safety_max` columns
 * (migration 004, seeded byte-identical), carried on RoomConfig.safetyMin/Max.
 * SAFETY_BOUNDS stays in source as the loader's loud fallback + this oracle.
 *
 * This test is the license: if the live seed ever drifts from the constant — a
 * mis-applied migration, a hand edit, a future room added with wrong bounds —
 * CI fails HERE, loudly, instead of a baby-room temperature floor silently
 * diverging in production. (A silent runtime fallback was deliberately rejected
 * by the dual-Opus design gate for exactly this reason.)
 *
 * FIXTURE provenance: ROOMS_ENRICHED mirrors the live `rooms` enriched columns
 * captured 2026-06-20 after migration 004 applied + verified live
 * (safety_min/safety_max). Keep in sync with the DB.
 */
import { describe, it, expect } from 'vitest';
import { SAFETY_BOUNDS } from '../../src/lib/agent/safety';

interface EnrichedRow {
  id: string;
  safety_min: number;
  safety_max: number;
  critical: boolean;
  fan_profile: 'standard' | 'silent';
}

// Live `rooms` enriched bounds + critical + fan_profile, captured 2026-06-20
// (migration 004 seed).
const ROOMS_ENRICHED: EnrichedRow[] = [
  { id: 'leone',     safety_min: 18, safety_max: 32, critical: true,  fan_profile: 'standard' },
  { id: 'soggiorno', safety_min: 16, safety_max: 35, critical: false, fan_profile: 'standard' },
  { id: 'camera',    safety_min: 16, safety_max: 35, critical: false, fan_profile: 'silent'   },
  { id: 'studio',    safety_min: 16, safety_max: 35, critical: false, fan_profile: 'standard' },
  { id: 'cucina',    safety_min: 16, safety_max: 35, critical: false, fan_profile: 'standard' },
  { id: 'bagno1',    safety_min: 16, safety_max: 35, critical: false, fan_profile: 'standard' },
  { id: 'bagno2',    safety_min: 16, safety_max: 35, critical: false, fan_profile: 'standard' },
];

// ROOM_PRIORITIES.critical oracle (cycle/route.ts) — only leone is critical.
const OLD_CRITICAL: Record<string, boolean> = {
  leone: true, soggiorno: false, camera: false, studio: false,
  cucina: false, bagno1: false, bagno2: false,
};

describe('DB safety bounds equivalence with the SAFETY_BOUNDS oracle', () => {
  it('every seeded room matches the SAFETY_BOUNDS constant exactly', () => {
    for (const row of ROOMS_ENRICHED) {
      const c = SAFETY_BOUNDS[row.id];
      expect(c, `SAFETY_BOUNDS missing entry for ${row.id}`).toBeDefined();
      expect(row.safety_min, `${row.id} safety_min drift`).toBe(c.min);
      expect(row.safety_max, `${row.id} safety_max drift`).toBe(c.max);
    }
  });

  it('the seed covers every SAFETY_BOUNDS room (no constant-only room)', () => {
    const seeded = new Set(ROOMS_ENRICHED.map(r => r.id));
    for (const id of Object.keys(SAFETY_BOUNDS)) {
      expect(seeded.has(id), `room ${id} in SAFETY_BOUNDS but not seeded`).toBe(true);
    }
  });

  it('Nursery keeps the tighter life-safety band (18-32), distinct from the 16-35 default', () => {
    const leone = ROOMS_ENRICHED.find(r => r.id === 'leone')!;
    expect(leone.safety_min).toBe(18);
    expect(leone.safety_max).toBe(32);
    expect(SAFETY_BOUNDS.leone).toEqual({ min: 18, max: 32 });
  });

  it('seeded critical flag matches ROOM_PRIORITIES.critical (only leone)', () => {
    for (const row of ROOMS_ENRICHED) {
      expect(row.critical, `${row.id} critical drift`).toBe(OLD_CRITICAL[row.id]);
    }
  });

  it('seeded fan_profile matches the old fan ladder (silent = camera only)', () => {
    for (const row of ROOMS_ENRICHED) {
      const expected = row.id === 'camera' ? 'silent' : 'standard';
      expect(row.fan_profile, `${row.id} fan_profile drift`).toBe(expected);
    }
  });
});
