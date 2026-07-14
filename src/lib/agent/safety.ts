// ─── Room Configuration ────────────────────────────────────────────────────────

export interface RoomConfig {
  target: number;        // from DB + outdoor compensation
  baseTarget: number;    // from DB (what user set)
  compensation: number;  // outdoor temp offset applied
  onThreshold: number;   // target - HYSTERESIS
  offThreshold: number;  // target + HYSTERESIS
  critical: boolean;
  priority: number;
  // Phase 3b: per-room life-safety bounds carried from the DB `rooms` table
  // (columns safety_min/safety_max). loadRoomConfigs — the SOLE builder of this
  // struct — guarantees these are finite numbers (Number.isFinite-guarded,
  // falling back to the SAFETY_BOUNDS constant on a malformed/null row), so
  // consumers read config.safetyMin/safetyMax directly with no undefined→NaN
  // risk. The module-level SAFETY_BOUNDS below is now the seed oracle (pinned
  // by tests/unit/safety-bounds.test.ts) + the loader's fallback, NOT a
  // runtime read on the actuation path.
  safetyMin: number;
  safetyMax: number;
  // Phase 3b: fan ladder selector from the DB `rooms.fan_profile` column.
  // 'silent' = the camera (matrimoniale) quiet ladder; 'standard' = everyone
  // else. Replaces the `roomId === 'camera'` literal branch in computeFanSpeed.
  fanProfile: 'standard' | 'silent';
  // Phase 7/8: which vendor drives this room. The cycle branches actuation on
  // it — 'sabiana' is Milano's fancoils, 'melcloud' is Campomarino's splits.
  apiSource: string;
  // Phase 8: vendor device id (TEXT in DB; numeric MELCloud ids coerced at the
  // client boundary). Null for rooms without a device (bathrooms).
  deviceId: string | null;
  // Phase 8: actuation gate. The agent reads/logs/records a room regardless,
  // but only ever sends a command when this is TRUE. FAIL CLOSED: the loader
  // sets it false on any missing/non-true DB value. Read fresh every cycle
  // (loadRoomConfigs is uncached) so a manual "disable" takes effect next tick.
  actuationEnabled: boolean;
}

/**
 * Safety bounds — absolute emergency limits that bypass the normal control
 * loop. Designed asymmetrically by season:
 *
 *   Winter (heating system):
 *     - min critical = 16°C: under this the boiler genuinely failed to keep
 *       up. Emergency boost so pipes don't freeze and the family stays warm.
 *     - max critical = 35°C: the boiler-driven loop has no realistic way to
 *       drive a room past 30°C, so this is just a "something is very wrong"
 *       upper bound.
 *
 *   Summer (chiller, optional + variable supply temp):
 *     - min critical = 16°C: chiller can't realistically drag a Milan
 *       apartment that low.
 *     - max critical = 35°C: above this it's actually unsafe (heatwave +
 *       broken cooling). At 28-32°C it's just "warm Milan summer" — NOT
 *       an emergency that should override user-chosen setpoints.
 *
 *   Nursery (baby room) — TIGHTER, SEASON-INDEPENDENT clamp:
 *     - 18°C / 28°C, both directions are life-safety. A neonate can't
 *       regulate temperature. Any value outside this triggers emergency
 *       actuation regardless of season.
 */
// Phase 3b: this map is now the SEED ORACLE and the loader fallback, NOT a
// runtime read on the actuation path. The live `rooms.safety_min/safety_max`
// columns (migration 004) are seeded byte-identical to these values and are the
// runtime source via RoomConfig.safetyMin/safetyMax. tests/unit/safety-bounds.test.ts
// pins DB-seed == this map so any drift fails CI loudly instead of degrading
// silently in production. Consumers must read config.safetyMin/safetyMax, never
// SAFETY_BOUNDS[roomId] directly.
export const SAFETY_BOUNDS: Record<string, { min: number; max: number }> = {
  // Nursery — life-safety bounds for a neonate that can't thermoregulate.
  // 18°C floor unchanged: hypothermia risk below.
  // 32°C ceiling (was 28): 28°C was a comfort threshold, not a safety
  // threshold. Real heatstroke risk for infants starts well above 30°C.
  // Comfort cooling 28-32 is handled by the normal cool ladder; only at
  // 32°C+ does the safety branch take over with emergency fan.
  leone:     { min: 18, max: 32 },
  soggiorno: { min: 16, max: 35 },
  camera:    { min: 16, max: 35 },
  studio:    { min: 16, max: 35 },
  cucina:    { min: 16, max: 35 },
  bagno1:    { min: 16, max: 35 },
  bagno2:    { min: 16, max: 35 },
};

export const SENSOR_FAULT_THRESHOLD = 3;  // 3 consecutive null readings = fault

// ─── Safety invariants (bypass ALL other logic) ────────────────────────────────

export interface SafetyAction {
  mode: 'heat' | 'cool' | 'off';
  setpoint: number;
  fan: number;
  severity: string;
  message: string;
}

export type SafetySeason = 'heat' | 'cool' | 'off';

export function checkSafetyInvariants(
  roomId: string,
  temp: number | null,
  consecutiveNulls: number,
  config: RoomConfig,
  season: SafetySeason = 'heat',
): SafetyAction | null {
  // Read bounds from the config (DB-sourced, Phase 3b). The guard preserves the
  // former "room not in SAFETY_BOUNDS → no safety actuation" semantics: a config
  // without finite bounds yields no action. loadRoomConfigs guarantees finite
  // bounds for every known room, so this is byte-identical for Milano.
  const safety =
    Number.isFinite(config.safetyMin) && Number.isFinite(config.safetyMax)
      ? { min: config.safetyMin, max: config.safetyMax }
      : null;
  if (!safety) return null;

  // Nursery sensor fault → defensive actuation (warm in winter, cool in summer)
  if (roomId === 'leone' && temp === null && consecutiveNulls >= SENSOR_FAULT_THRESHOLD) {
    if (season === 'cool') {
      return {
        mode: 'cool', setpoint: Math.max(safety.min, config.target - 0.5), fan: 1,
        severity: 'warning',
        message: `Sensore Nursery non risponde da ${consecutiveNulls * 2} min — raffrescamento difensivo`,
      };
    }
    return {
      mode: 'heat', setpoint: config.target + 0.5, fan: 1,
      severity: 'warning',
      message: `Sensore Nursery non risponde da ${consecutiveNulls * 2} min — riscaldamento difensivo`,
    };
  }

  if (temp === null) return null;

  // Nursery emergency: too cold (always rescue with heat regardless of season —
  // baby room cannot stay under safety.min).
  if (roomId === 'leone' && temp < safety.min) {
    return {
      mode: 'heat', setpoint: config.target + 2.0, fan: 2,
      severity: 'critical',
      message: `Nursery a ${temp}°C — riscaldamento emergenza (< ${safety.min}°C)`,
    };
  }

  // Nursery emergency: too hot (always rescue with cool when above safety.max —
  // even when season=heat, an overheated baby room must vent. In winter we
  // fall back to mode='off' if cool is unavailable upstream.)
  if (roomId === 'leone' && temp > safety.max) {
    if (season === 'cool') {
      return {
        mode: 'cool', setpoint: Math.max(safety.min, config.target - 2.0), fan: 2,
        severity: 'critical',
        message: `Nursery a ${temp}°C — raffrescamento emergenza (> ${safety.max}°C)`,
      };
    }
    return {
      mode: 'off', setpoint: config.target, fan: 1,
      severity: 'critical',
      message: `Nursery a ${temp}°C — spento per surriscaldamento (> ${safety.max}°C)`,
    };
  }

  // Any room below safety min → heat rescue
  if (temp < safety.min) {
    return {
      mode: 'heat', setpoint: config.target + 2.0, fan: 3,
      severity: 'critical',
      message: `${roomId} a ${temp}°C — sotto limite sicurezza (${safety.min}°C)`,
    };
  }

  // Any room above safety max → cool rescue when summer, else off
  if (temp > safety.max) {
    if (season === 'cool') {
      return {
        mode: 'cool', setpoint: Math.max(safety.min, config.target - 2.0), fan: 3,
        severity: 'critical',
        message: `${roomId} a ${temp}°C — sopra limite sicurezza (${safety.max}°C) — raffrescamento`,
      };
    }
    return {
      mode: 'off', setpoint: config.target, fan: 1,
      severity: 'critical',
      message: `${roomId} a ${temp}°C — sopra limite sicurezza (${safety.max}°C)`,
    };
  }

  return null;
}
