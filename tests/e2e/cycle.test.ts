/**
 * E2E tests for GET /api/agent/cycle (live prod).
 * Read-only: every test asserts on the live response shape + invariants.
 *
 * Strategy: cache one cycle response in beforeAll and share across most
 * tests — this minimises hardware side-effects (each live call can emit
 * a Sabiana/Netatmo command). Tests that genuinely need a second call
 * (idempotency, monotonic cycle count) make their own extra request.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

const PROD_URL = 'https://your-deployment.vercel.app';
const CYCLE_PATH = '/api/agent/cycle';
const KNOWN_ROOMS = new Set([
  'leone', 'soggiorno', 'camera', 'studio', 'cucina', 'bagno1', 'bagno2',
]);
const MAX_DURATION_MS = 55_000;

function loadSecret(): string {
  const envPath = resolve(process.cwd(), '.env.local');
  const raw = readFileSync(envPath, 'utf8');
  const match = raw.split('\n').find((l) => l.startsWith('AGENT_CRON_SECRET='));
  if (!match) throw new Error('AGENT_CRON_SECRET missing in .env.local');
  return match.slice('AGENT_CRON_SECRET='.length).trim();
}

interface CycleResponse {
  ok: boolean;
  cycle: number;
  elapsed: number;
  correcting: boolean;
  heating: string[];
  log: string[];
}

async function callCycle(
  authHeader: string | undefined,
): Promise<{ status: number; body: CycleResponse | { error?: string } }> {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  const res = await fetch(`${PROD_URL}${CYCLE_PATH}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe('cycle endpoint E2E', () => {
  let secret: string;
  let first: CycleResponse;

  beforeAll(async () => {
    secret = loadSecret();
    const res = await callCycle(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    first = res.body as CycleResponse;
  });

  // ── Iter 1: baseline happy path ──────────────────────────────────────────────
  it('returns 200 + ok:true with valid auth', () => {
    expect(first.ok).toBe(true);
  });

  // ── Iter 2 + 3: auth ────────────────────────────────────────────────────────
  it('rejects a request with no Authorization header (401)', async () => {
    const { status, body } = await callCycle(undefined);
    expect(status).toBe(401);
    expect((body as { error?: string }).error).toBe('Unauthorized');
  });

  it('rejects a wrong bearer token (401)', async () => {
    const { status, body } = await callCycle('Bearer not-the-real-secret');
    expect(status).toBe(401);
    expect((body as { error?: string }).error).toBe('Unauthorized');
  });

  // ── Iter 4: cycle counter monotonic ─────────────────────────────────────────
  it('increments cycle counter on each invocation', async () => {
    const { status, body } = await callCycle(`Bearer ${secret}`);
    expect(status).toBe(200);
    const second = body as CycleResponse;
    expect(second.cycle).toBeGreaterThan(first.cycle);
  });

  // ── Iter 5: heating set ⊆ known rooms ───────────────────────────────────────
  it('heating array is a subset of the known room catalog', () => {
    expect(Array.isArray(first.heating)).toBe(true);
    for (const room of first.heating) {
      expect(KNOWN_ROOMS.has(room)).toBe(true);
    }
  });

  // ── Iter 6: first log line matches the Cycle #N header ──────────────────────
  it('first log line carries the "Cycle #<n> | Outdoor: ..." header', () => {
    expect(first.log.length).toBeGreaterThan(0);
    expect(first.log[0]).toMatch(
      /^Cycle #\d+ \| Outdoor: -?\d+(?:\.\d+)?°C.*\| Sensors: \d+\/7/,
    );
  });

  // ── Iter 7: camera runs through the normal state machine ────────────────────
  // camera used to be in DISABLED_ROOMS (kept manual in winter). It was
  // re-enabled 2026-05-25 (DISABLED_ROOMS = empty set), so it now goes through
  // the normal per-room loop and must NOT log "DISABLED". Per-room lines are
  // only emitted when the state machine runs; in season=off the state machine
  // is gated (shutdownRoomOff path), so we only assert for heat/cool.
  it('camera room is managed (not DISABLED) in the per-room log', () => {
    const header = first.log[0] ?? '';
    if (/season=off/.test(header)) return;
    const cameraLine = first.log.find((l) => l.startsWith('camera:'));
    expect(cameraLine).toBeDefined();
    expect(cameraLine).not.toBe('camera: DISABLED');
  });

  // ── Iter 8: therm management line present and parsable ──────────────────────
  // - season=heat → therm: <verb> from manageThermostat
  // - season=cool → therm: <ensureSmartherSummerOpen outcome> (keeps zone valve
  //   open for the chiller — opened / already_open / no_netatmo_* / open error)
  // - season=off  → global-off: summary line (fancoils shut down); therm: line
  //   from ensureSmartherClosed is also present.
  it('emits the correct therm: behaviour for the current season', () => {
    const header = first.log[0] ?? '';
    const isOff = /season=off/.test(header);
    const isCool = /season=cool/.test(header);
    if (isOff) {
      const offLine = first.log.find((l) => l.startsWith('global-off:'));
      expect(offLine).toBeDefined();
      return;
    }
    const termLine = first.log.find((l) => l.startsWith('therm:'));
    expect(termLine).toBeDefined();
    if (isCool) {
      // Summer: ensureSmartherSummerOpen pins the Smarther valve open.
      expect(termLine).toMatch(
        /^therm: (opened|already_open|no_netatmo|no_thermostat|ctx_failed|open error|open_failed)/,
      );
    } else {
      expect(termLine).toMatch(
        /^therm: (noop|override|skip|restored_to_schedule|restore_failed|sentinel|idle|Thermostat error)/,
      );
    }
  });

  // ── Iter 9: elapsed < maxDuration (Vercel route config) ─────────────────────
  it('elapsed time stays well below the 55s maxDuration budget', () => {
    expect(typeof first.elapsed).toBe('number');
    expect(first.elapsed).toBeGreaterThan(0);
    expect(first.elapsed).toBeLessThan(MAX_DURATION_MS);
  });

  // ── Iter 10: sensor count in status header matches /7 catalog ───────────────
  it('status header reports Sensors: N/7 with N in [0,7]', () => {
    const match = first.log[0].match(/Sensors: (\d+)\/7/);
    expect(match).not.toBeNull();
    const n = Number(match![1]);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(7);
  });

  // ── Global-OFF invariants ───────────────────────────────────────────────────
  // When season=off the agent runs a total shutdown (not just gating). It must:
  // (a) announce season in the header,
  // (b) emit a 'global-off:' summary line (fancoils shut down idempotently),
  // (c) attempt bathroom antifreeze once per transition ('antifreeze:'),
  // (d) emit a 'therm:' line from ensureSmartherClosed (release zone valve).
  // If season≠off these checks are skipped.
  it('global-off surfaces season=off + global-off + antifreeze + therm lines', () => {
    const header = first.log[0] ?? '';
    if (!/season=off/.test(header)) return;
    const offLine = first.log.find((l) => l.startsWith('global-off:'));
    expect(offLine).toBeDefined();
    const antifreezeLine = first.log.find((l) => l.startsWith('antifreeze:'));
    expect(antifreezeLine).toBeDefined();
    // The global-off branch DOES emit a therm: line (Smarther release).
    const termLine = first.log.find((l) => l.startsWith('therm:'));
    expect(termLine).toBeDefined();
  });

  // ── Iter 11: response shape — every key is the expected type ───────────────
  it('response object has the full expected shape and types', () => {
    expect(typeof first.ok).toBe('boolean');
    expect(typeof first.cycle).toBe('number');
    expect(Number.isInteger(first.cycle)).toBe(true);
    expect(typeof first.elapsed).toBe('number');
    expect(typeof first.correcting).toBe('boolean');
    expect(Array.isArray(first.heating)).toBe(true);
    expect(Array.isArray(first.log)).toBe(true);
    for (const line of first.log) expect(typeof line).toBe('string');
  });
});

// ─── Per-property routing (Phase 8/10.1) ────────────────────────────────────────
// The cycle serves two homes. Milano (no ?property, tested above) stays
// byte-identical; campomarino (?property=campomarino) reads its 3 MELCloud
// splits and — with every room's actuation gate off — sends ZERO commands.

interface CampoResponse {
  ok: boolean;
  cycle: number;
  property?: string;
  elapsed: number;
  log: string[];
}

async function callCycleProperty(
  property: string,
  authHeader: string | undefined,
): Promise<{ status: number; body: CampoResponse | { error?: string; property?: string } }> {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.Authorization = authHeader;
  const res = await fetch(`${PROD_URL}${CYCLE_PATH}?property=${encodeURIComponent(property)}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json() };
}

describe('cycle endpoint — campomarino branch E2E', () => {
  let secret: string;
  let campo: CampoResponse;

  beforeAll(async () => {
    secret = loadSecret();
    const res = await callCycleProperty('campomarino', `Bearer ${secret}`);
    expect(res.status).toBe(200);
    campo = res.body as CampoResponse;
  });

  it('returns ok + property=campomarino', () => {
    expect(campo.ok).toBe(true);
    expect(campo.property).toBe('campomarino');
  });

  it('emits the [campomarino] header with splits read N/3', () => {
    // Per-room transition lines can precede the header, so match anywhere — not log[0].
    const header = campo.log.find((l) => /^Cycle #\d+ \[campomarino\] \| Outdoor: .* \| splits read: \d+\/\d+ \| season=/.test(l));
    expect(header).toBeDefined();
  });

  it('actuation gate summary is present with sane counts (actuated≥0, gated≥0)', () => {
    // Campomarino is ACTIVE since migration 007 — actuated may be >0 (rooms get
    // commanded each cycle). The gate-summary line must exist with non-negative
    // counts; it is no longer pinned to 0 (that was the pre-activation baseline).
    const line = campo.log.find((l) => l.startsWith('campomarino:'));
    expect(line).toBeDefined();
    const m = line!.match(/actuated=(\d+) gated=(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
    expect(Number(m![2])).toBeGreaterThanOrEqual(0);
  });

  it('never emits a Milano-only block (no global-off/OFF-guard/antifreeze)', () => {
    for (const l of campo.log) {
      expect(l.startsWith('global-off:')).toBe(false);
      expect(l.startsWith('OFF-guard:')).toBe(false);
      expect(l.startsWith('antifreeze:')).toBe(false);
    }
  });

  it('rejects an unknown property with 400 (never silent fall-through)', async () => {
    const { status, body } = await callCycleProperty('Milano_typo', `Bearer ${secret}`);
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBe('unknown_property');
  });

  it('elapsed stays under the 55s budget', () => {
    expect(campo.elapsed).toBeGreaterThan(0);
    expect(campo.elapsed).toBeLessThan(MAX_DURATION_MS);
  });
});
