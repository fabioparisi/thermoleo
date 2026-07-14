export interface SabianaJWT {
  token: string;
  expiresAt: Date;
}

export interface SabianaDevice {
  id: string;
  name: string;
  connectionUp: boolean;
  modelType: string; // 'evo' (CB-Touch) or 'tmb' (T-MB2)
  wifiRSSI: number;
  firmwareVersion: string;
  lastData: string; // hex-encoded device state
}

export interface SabianaDeviceState {
  deviceId: string;
  deviceName: string;
  connectionUp: boolean;
  temperature: number;     // T1 - measured room temp at the fancoil's intake grille (°C)
  setpoint: number;        // active setpoint for the running mode (°C)
  setpointCool: number;    // stored summer/cool setpoint (Modbus register, °C)
  setpointHeat: number;    // stored winter/heat setpoint (Modbus register, °C)
  setpointAuto: number;    // stored auto setpoint (Modbus register, °C)
  fanSpeed: number;        // fan command echoed by device: 1=Low, 2=Med, 3=High, 4=Auto, 0=idle/off
  fanSpeedRaw: number;     // raw byte 7 value (upper nibble is fan: 0-3 running, >3 idle/off)
  flapPosition: number;    // byte 8: 0-4 valid positions, 255 = invalid/uninitialised
  mode: SabianaMode;       // thermal mode reported by byte[5] (heat/cool/auto); NOT the ON/OFF verdict
  fanRunning: boolean;     // true when fan is moving air (byte[7] nibble 0-3): reliable ON signal
  storedMode: SabianaMode; // alias of mode — thermal mode for the api/rooms ON/OFF decision
  modelType: string;
}

export type SabianaMode = 'cool' | 'heat' | 'fan_only' | 'off';

export interface SabianaCommand {
  fan: number;       // 1=Low, 2=Med, 3=High, 4=Auto
  mode: SabianaMode;
  temperature: number;
  swing: number;     // 1=Horiz, 2=45deg, 3=Vert, 4=Swing
  preset: number;    // 0=None, 2=Sleep
}

export interface SabianaAuthTokens {
  shortJwt: SabianaJWT;
  longJwt: SabianaJWT;
}
