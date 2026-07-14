/**
 * Unit tests for the MELCloud SetAta payload builder (pure, no network).
 *
 * EffectiveFlags is a bitmask: MELCloud applies ONLY the fields whose bit is
 * set. A wrong/missing bit = a silent no-op command (a heat command that never
 * reaches Nursery's room). These pin the bit math + the per-mode SetTemperature
 * clamp + the off path.
 */
import { describe, it, expect } from 'vitest';
import { buildSetAtaPayload } from '../../src/lib/melcloud/client';
import type { MelDeviceState } from '../../src/lib/melcloud/types';

const dev: MelDeviceState = {
  deviceId: 80979947, buildingId: 622008, name: 'Studio',
  roomTemperature: 27, setTemperature: 25, operationMode: 3, power: true, fanSpeed: 0,
  outdoorTemperature: 24,
  minTempCoolDry: 16, maxTempCoolDry: 31,
  minTempHeat: 10, maxTempHeat: 31,
  minTempAuto: 16, maxTempAuto: 31,
};

describe('buildSetAtaPayload — EffectiveFlags bitmask', () => {
  it('cool + temp + fan sets Power|Mode|Temp|Fan|VaneVertical = 0x1F', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: true, mode: 'cool', temperature: 26.5, fan: 'auto' }, dev);
    // 0x1 (Power) | 0x2 (Mode) | 0x4 (Temp) | 0x8 (Fan) | 0x10 (VaneVertical) = 31
    expect(p.EffectiveFlags).toBe(0x1F);
    expect(p.Power).toBe(true);
    expect(p.OperationMode).toBe(3); // cool
    expect(p.SetTemperature).toBe(26.5);
    expect(p.SetFanSpeed).toBe(0); // auto
    expect(p.VaneVertical).toBe(1); // upwards, never swing
  });

  it('off → Power=false, no mode/temp/fan/vane, only the Power bit set', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: false, mode: 'off', temperature: 26.5, fan: 3 }, dev);
    expect(p.Power).toBe(false);
    expect(p.EffectiveFlags).toBe(0x1); // Power only — off doesn't set the vane
    expect(p.OperationMode).toBeUndefined();
    expect(p.SetTemperature).toBeUndefined();
    expect(p.SetFanSpeed).toBeUndefined();
    expect(p.VaneVertical).toBeUndefined();
  });

  it('power-on defaults the vane UPWARDS (1) when not specified, never swing (7)', () => {
    for (const mode of ['cool', 'dry', 'heat'] as const) {
      const p = buildSetAtaPayload(dev.deviceId, { power: true, mode }, dev);
      expect(p.VaneVertical).toBe(1);
      expect((p.EffectiveFlags as number) & 0x10).toBe(0x10);
    }
  });

  it('explicit vaneVertical (soggiorno=5, downwards) overrides the default', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: true, mode: 'cool', vaneVertical: 5 }, dev);
    expect(p.VaneVertical).toBe(5); // downwards
    expect((p.EffectiveFlags as number) & 0x10).toBe(0x10);
  });

  it('off ignores vaneVertical entirely', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: false, mode: 'off', vaneVertical: 5 }, dev);
    expect(p.VaneVertical).toBeUndefined();
    expect(p.EffectiveFlags).toBe(0x1);
  });

  it('heat clamps SetTemperature to the HEAT range (not the cool range)', () => {
    // heat range 10-31; a 5°C target clamps up to 10, not the cool floor 16.
    const p = buildSetAtaPayload(dev.deviceId, { power: true, mode: 'heat', temperature: 5 }, dev);
    expect(p.OperationMode).toBe(1); // heat
    expect(p.SetTemperature).toBe(10); // clamped to minTempHeat
    expect(p.EffectiveFlags).toBe(0x1 | 0x2 | 0x4 | 0x10); // Power|Mode|Temp|Vane, no fan
    expect(p.VaneVertical).toBe(1);
  });

  it('cool clamps SetTemperature to the COOL range', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: true, mode: 'cool', temperature: 12 }, dev);
    expect(p.SetTemperature).toBe(16); // clamped to minTempCoolDry
  });

  it('silent fan maps to 255', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: true, mode: 'cool', fan: 'silent' }, dev);
    expect(p.SetFanSpeed).toBe(255);
    expect((p.EffectiveFlags as number) & 0x8).toBe(0x8);
  });

  it('numeric fan level 3 maps to 3', () => {
    const p = buildSetAtaPayload(dev.deviceId, { power: true, mode: 'heat', fan: 3 }, dev);
    expect(p.SetFanSpeed).toBe(3);
  });
});
