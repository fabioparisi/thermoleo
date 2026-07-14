/**
 * MELCloud "Classic" API types — only the subset the campomarino agent needs.
 *
 * Wire-level facts (endpoints, EffectiveFlags, enum values) are documented in
 * `docs/melcloud-api-reference.md`, distilled from OlivierZal/melcloud-api.
 * We deliberately do NOT vendor that library (Node ≥22 / Temporal); this is a
 * thin client over the same HTTP surface.
 */

// ─── Operation mode (ATA, air-to-air split heat pump) ───────────────────────────
// Wire values are numeric. Campomarino runs full heat/cool/off per-property.
export const MEL_MODE = {
  heat: 1,
  dry: 2,
  cool: 3,
  fan: 7,
  auto: 8,
} as const;
export type MelMode = (typeof MEL_MODE)[keyof typeof MEL_MODE];

// ─── Fan speed ──────────────────────────────────────────────────────────────────
export const MEL_FAN = {
  auto: 0,
  very_slow: 1,
  slow: 2,
  moderate: 3,
  fast: 4,
  very_fast: 5,
  silent: 255,
} as const;
export type MelFan = (typeof MEL_FAN)[keyof typeof MEL_FAN];

// ─── EffectiveFlags bitmask (ATA) ───────────────────────────────────────────────
// The set-device payload only applies fields whose bit is set. OR the bits for
// every field being changed, or the change is silently ignored by MELCloud.
export const MEL_FLAG = {
  Power: 0x1,
  OperationMode: 0x2,
  SetTemperature: 0x4,
  SetFanSpeed: 0x8,
  VaneVertical: 0x10,
  VaneHorizontal: 0x100,
} as const;

/** Persisted auth: only the ContextKey (never the password). */
export interface MelContext {
  contextKey: string;
  /** Epoch ms when this context was obtained (for staleness / logging only). */
  obtainedAt: number;
}

/** One ATA device's current state, normalized from a ListDevices/Get payload. */
export interface MelDeviceState {
  deviceId: number;
  buildingId: number;
  name: string;
  /** Internal split thermometer (°C). The agent's sensor fallback before Shelly. */
  roomTemperature: number | null;
  setTemperature: number | null;
  /** Numeric MELCloud OperationMode (MEL_MODE values). */
  operationMode: number | null;
  power: boolean | null;
  fanSpeed: number | null;
  outdoorTemperature: number | null;
  /** Per-mode clamp bounds the device advertises (used before SetAta). */
  minTempCoolDry: number | null;
  maxTempCoolDry: number | null;
  minTempHeat: number | null;
  maxTempHeat: number | null;
  minTempAuto: number | null;
  maxTempAuto: number | null;
}

/** What the agent asks the client to set on one unit. */
export interface MelSetCommand {
  power: boolean;
  /** Abstract mode; mapped to MEL_MODE inside the client. */
  mode: 'heat' | 'cool' | 'dry' | 'fan' | 'auto' | 'off';
  temperature?: number;
  /** Abstract fan: 'auto' | 'silent' | 1..5. Mapped to MEL_FAN inside the client. */
  fan?: 'auto' | 'silent' | number;
  /** Vertical vane position (ClassicVertical): 1=upwards (default), 3=middle,
   *  5=downwards, 7=swing. Omit → upwards. Per-room (e.g. soggiorno=5). */
  vaneVertical?: number;
}
