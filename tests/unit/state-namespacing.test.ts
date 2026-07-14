/**
 * Unit tests for Phase 5 tokens-namespacing in agent state persistence.
 *
 * Pins the two things both review boards flagged as the riskiest in the whole
 * change:
 *   1. loadAgentState reads the SUFFIXED provider first, falls back to the nude
 *      row during the drain, and stamps `_provider` with whichever it found.
 *   2. saveAgentState NEVER persists `_provider` into the row's `data` (it's the
 *      row's address, not its contents) and CAS-PATCHes the SAME provider key it
 *      loaded — no suffixed/nude split.
 *
 * Pure fetch-stub, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAgentState, saveAgentState, type AgentState } from '../../src/lib/agent/state';

const realFetch = global.fetch;

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

// Pull the provider= value out of a tokens REST URL.
function providerOf(url: string): string {
  const m = /provider=eq\.([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('loadAgentState provider resolution', () => {
  it('reads the suffixed row first and stamps _provider with it', async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seen.push(providerOf(String(url)));
      // suffixed row present
      return jsonRes([{ data: { cycleCount: 7, version: 3 } }]);
    }) as unknown as typeof fetch;

    const state = await loadAgentState('milano');
    expect(seen[0]).toBe('agent_state:milano');
    expect(state._provider).toBe('agent_state:milano');
    expect(state.cycleCount).toBe(7);
  });

  it('falls back to the nude row when the suffixed one is absent', async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      const p = providerOf(String(url));
      seen.push(p);
      return jsonRes(p === 'agent_state' ? [{ data: { cycleCount: 9, version: 5 } }] : []);
    }) as unknown as typeof fetch;

    const state = await loadAgentState('milano');
    expect(seen).toEqual(['agent_state:milano', 'agent_state']);
    expect(state._provider).toBe('agent_state'); // matched the nude row → write nude
    expect(state.cycleCount).toBe(9);
  });

  it('defaults _provider to the suffixed key on a total miss', async () => {
    global.fetch = vi.fn(async () => jsonRes([])) as unknown as typeof fetch;
    const state = await loadAgentState('milano');
    expect(state._provider).toBe('agent_state:milano');
  });
});

describe('saveAgentState provider + _provider hygiene', () => {
  function baseState(provider: string): AgentState {
    return {
      cycleCount: 1, roomStates: {}, originalThermostatSetpoint: null,
      lastThermostatCommandTime: 0, alertCooldowns: {}, lastCycleTime: 0,
      correcting: false, sentinelActive: false, lastSentinelCommandTime: 0,
      bathroomsAntifrozenAt: null, smartherSummerOpenAt: null, smartherClosedAt: null,
      version: 3, _provider: provider,
    } as AgentState;
  }

  it('CAS-PATCHes the SAME provider it loaded and strips _provider from data', async () => {
    let patchUrl = '';
    let patchedData: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      patchUrl = String(url);
      patchedData = JSON.parse(String(init?.body)).data;
      return jsonRes([{ data: patchedData }]); // 1 row matched → CAS won
    }) as unknown as typeof fetch;

    await saveAgentState(baseState('agent_state:milano'));
    expect(providerOf(patchUrl)).toBe('agent_state:milano');
    expect(patchUrl).toContain('data->>version=eq.3');
    // The persisted blob must NOT carry the row-address marker.
    expect(patchedData).toBeDefined();
    expect('_provider' in patchedData!).toBe(false);
    expect(patchedData!.version).toBe(4); // bumped
  });

  it('writes the nude provider when state was loaded nude (drain window)', async () => {
    let patchUrl = '';
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      patchUrl = String(url);
      return jsonRes([{ data: JSON.parse(String(init?.body)).data }]);
    }) as unknown as typeof fetch;

    await saveAgentState(baseState('agent_state'));
    expect(providerOf(patchUrl)).toBe('agent_state');
  });
});
