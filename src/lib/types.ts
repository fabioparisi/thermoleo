export interface RoomStatus {
  roomId: string;
  name: string;
  icon: string;
  temperature: number | null;
  setpoint: number | null;
  humidity: number | null;
  /** Fan rung the UI shows. Campomarino ladder: 0=silent, 1-3=slow/mid/fast.
   *  Sabiana: 1-4. null → UI default. */
  fanSpeed: number | null;
  mode: string;
  /** Campomarino only: the user's manual mode pin ('cool'|'dry'), or null when
   *  the agent chooses automatically. Drives the cool/dry selector's active +
   *  "auto" state. Absent for Sabiana/Netatmo. */
  manualMode?: 'cool' | 'dry' | null;
  connectionUp: boolean;
  apiSource: 'sabiana' | 'netatmo' | 'melcloud';
  priority: number;
  targetTemp: number;
  /** Persisted winter heating target (°C), null if pre-migration. */
  targetWinter?: number | null;
  /** Persisted summer cooling target (°C), null if pre-migration. */
  targetSummer?: number | null;
  hasFanControl: boolean;
  deviceId?: string;
  netatmoRoomId?: string;
  /** Built-in device sensor temp (Sabiana fancoil or Netatmo valve), null if offline/stale */
  deviceTemp: number | null;
  /** Where the main temperature reading comes from: 'sonoff' | 'device' | null */
  tempSource?: string | null;
  /** Raw ECM motor speed byte from Sabiana (0 = fan idle, >10 = fan spinning) */
  fanSpeedRaw?: number | null;
  /** Netatmo heating power request (0-100%, null for non-Netatmo rooms) */
  heatingPowerRequest?: number | null;
  /** ISO timestamp of the last Sonoff bridge write for this room (null if never seen). */
  bridgeUpdatedAt?: string | null;
  /** Age in milliseconds of the last bridge reading; Infinity when unknown. */
  bridgeAgeMs?: number | null;
  /** True when the bridge is >5min stale for this room — UI should NOT treat temperature as live. */
  bridgeStale?: boolean;
  /** Which home this room belongs to ('milano' | 'campomarino'). Drives the UI's
   *  property selector. Optional so Milano payloads (which omit it) default. */
  propertyId?: string;
  /** Phase 9 — true when the room's actuation gate is open. Campomarino rooms
   *  read false until their independent sensor is validated; the UI shows a
   *  "sola lettura" badge and disables controls. */
  actuationEnabled?: boolean;
}

export type TempStatus = 'cold' | 'ok' | 'warm' | 'unknown';

/** ±0.2°C band around target */
export function getTempStatus(
  temp: number | null,
  target: number,
): TempStatus {
  if (temp === null) return 'unknown';
  if (temp < target - 0.2) return 'cold';
  if (temp > target + 0.2) return 'warm';
  return 'ok';
}

export function getTempStatusColor(status: TempStatus): string {
  switch (status) {
    case 'cold': return 'border-blue-500/60';
    case 'ok': return 'border-emerald-500/60';
    case 'warm': return 'border-amber-500/60';
    case 'unknown': return 'border-slate-700';
  }
}

export function getTempStatusGlow(status: TempStatus): string {
  switch (status) {
    case 'cold': return 'shadow-blue-500/20';
    case 'ok': return 'shadow-emerald-500/20';
    case 'warm': return 'shadow-amber-500/20';
    case 'unknown': return '';
  }
}
