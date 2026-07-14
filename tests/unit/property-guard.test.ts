/**
 * Unit tests for the multi-property rooms-fetch race guard.
 *
 * Pins the rule that prevented "tab Campomarino shows Milano's fancoils": a
 * /api/rooms reply for the previous property landing after a tab switch must
 * be dropped, never applied to state. Deterministic, no React, no network.
 */
import { describe, it, expect } from 'vitest';
import { shouldApplyRoomsReply } from '../../src/lib/property-guard';

describe('shouldApplyRoomsReply', () => {
  it('accepts a reply whose property matches both requested and current', () => {
    expect(shouldApplyRoomsReply('campomarino', 'campomarino', 'campomarino')).toBe(true);
    expect(shouldApplyRoomsReply('milano', 'milano', 'milano')).toBe(true);
  });

  it('drops a reply whose echoed property differs from the requested one', () => {
    // The server answered for milano but this fetch was issued for campomarino.
    expect(shouldApplyRoomsReply('milano', 'campomarino', 'campomarino')).toBe(false);
  });

  it('drops a correct reply that lands after the user switched homes (the race)', () => {
    // Fetch issued for milano, milano answered correctly, but the user is now
    // on campomarino — applying milano's rooms is exactly the bug.
    expect(shouldApplyRoomsReply('milano', 'milano', 'campomarino')).toBe(false);
  });

  it('drops the Campomarino reply that lands after switching back to Milano', () => {
    expect(shouldApplyRoomsReply('campomarino', 'campomarino', 'milano')).toBe(false);
  });

  it('accepts a legacy reply with no property field only when req==current', () => {
    expect(shouldApplyRoomsReply(undefined, 'milano', 'milano')).toBe(true);
    expect(shouldApplyRoomsReply(null, 'milano', 'milano')).toBe(true);
    // ...but a missing-property reply still can't override after a switch.
    expect(shouldApplyRoomsReply(undefined, 'milano', 'campomarino')).toBe(false);
  });
});
