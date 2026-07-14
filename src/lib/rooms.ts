export type ApiSource = 'sabiana' | 'netatmo';

export interface RoomConfig {
  id: string;
  name: string;
  icon: string;
  apiSource: ApiSource;
  deviceId?: string;        // Sabiana device ID or Netatmo room ID
  priority: number;         // 1 = high (Nursery), 0 = normal
  targetTemp: number;       // default — runtime value comes from DB
  hasFanControl: boolean;
}

// Device IDs from Sabiana API discovery (validated with Fabio)
export const SABIANA_DEVICE_MAP: Record<string, string> = {
  'swm-0C8B953686CE': 'camera',     // Fancoil camera da letto → Camera matrimoniale
  'swm-24DCC3FCF49E': 'soggiorno',  // Fancoil TV → Soggiorno
  'swm-3CE90EA00D82': 'cucina',     // Fancoil Cucina
  'swm-3CE90EA38D06': 'studio',     // Fancoil Studio Grande → Studio Fabio
  'swm-5443B26CD582': 'leone',      // Fancoil Studio Piccolo → Camera Nursery
};

export const ROOMS: RoomConfig[] = [
  {
    id: 'leone',
    name: "Camera Nursery",
    icon: '👶',
    apiSource: 'sabiana',
    priority: 1,
    targetTemp: 21,
    hasFanControl: true,
  },
  {
    id: 'bagno1',
    name: 'Bagno Vasca',
    icon: '🛁',
    apiSource: 'netatmo',
    priority: 0,
    targetTemp: 22,
    hasFanControl: false,
  },
  {
    id: 'camera',
    name: 'Camera da letto',
    icon: '🛏️',
    apiSource: 'sabiana',
    priority: 0,
    targetTemp: 20.5,
    hasFanControl: true,
  },
  {
    id: 'bagno2',
    name: 'Bagno Doccia',
    icon: '🚿',
    apiSource: 'netatmo',
    priority: 0,
    targetTemp: 22,
    hasFanControl: false,
  },
  {
    id: 'soggiorno',
    name: 'Soggiorno',
    icon: '🛋️',
    apiSource: 'sabiana',
    priority: 0,
    targetTemp: 21,
    hasFanControl: true,
  },
  {
    id: 'cucina',
    name: 'Cucina',
    icon: '🍳',
    apiSource: 'sabiana',
    priority: 0,
    targetTemp: 21,
    hasFanControl: true,
  },
  {
    id: 'studio',
    name: 'Studio Fabio',
    icon: '💻',
    apiSource: 'sabiana',
    priority: 0,
    targetTemp: 21,
    hasFanControl: true,
  },
];

export function getRoomById(id: string): RoomConfig | undefined {
  return ROOMS.find((r) => r.id === id);
}

export function getRoomForDevice(deviceId: string): string | undefined {
  return SABIANA_DEVICE_MAP[deviceId];
}
