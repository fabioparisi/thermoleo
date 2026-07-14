/**
 * Bathroom radiator antifreeze — idempotent.
 *
 * When the season flips to 'off' (interregno between heating cutoff and
 * chiller activation), the central hot-water loop is dead. Netatmo bathroom
 * valves, if left on their normal schedule, will still OPEN whenever the
 * room drops below target — asking for hot water that the boiler cannot
 * deliver. Symptoms: cold radiator body + warm humid bathroom air = thick
 * condensation on the metal, mould risk on grout/paint.
 *
 * Fix: push the two bathroom rooms to manual 7°C with a long endtime
 * (about 6 months). At 7°C the valve is effectively closed all summer,
 * no calls for heat, no condensation surface problem.
 *
 * This helper is idempotent via `state.bathroomsAntifrozenAt`:
 *   - null → transition not yet applied this offseason → call Netatmo
 *   - timestamp set → already applied → no-op (unless it was >90 days ago,
 *     which would mean the endtime is close to expiring; we refresh then)
 *
 * The caller is responsible for clearing `bathroomsAntifrozenAt` back to
 * null whenever `season !== 'off'` so the next cutoff re-arms cleanly.
 */

import { getValidAccessToken } from '@/lib/netatmo/token-store';
import { setRoomState } from '@/lib/netatmo/client';
import { loadNetatmoContext } from '@/lib/netatmo/context';
import type { AgentState } from '@/lib/agent/state';

const ANTIFREEZE_TEMP = 7;
// 180 days — covers Milan's full interregno (mid-Apr → late-Oct) with margin.
const ANTIFREEZE_ENDTIME_SEC = 180 * 24 * 60 * 60;
// If the recorded push is older than REFRESH_AFTER_MS, re-send to extend the
// endtime before it expires. 120 days < 180-day endtime, safe buffer.
const REFRESH_AFTER_MS = 120 * 24 * 60 * 60 * 1000;
const BATHROOM_ROOM_KEYS = ['bagno1', 'bagno2'] as const;

export interface AntifreezeOutcome {
  applied: boolean;
  reason: string;
  rooms: string[];
}

export async function ensureBathroomsAntifrozen(
  state: AgentState,
  now: number = Date.now(),
): Promise<AntifreezeOutcome> {
  const last = state.bathroomsAntifrozenAt;
  if (last !== null && now - last < REFRESH_AFTER_MS) {
    return { applied: false, reason: 'already_antifrozen', rooms: [] };
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { applied: false, reason: 'no_netatmo_token', rooms: [] };
  }

  let homeId: string;
  let roomMap: Record<string, string>;
  try {
    const ctx = await loadNetatmoContext();
    if (!ctx.homeId) return { applied: false, reason: 'no_netatmo_home', rooms: [] };
    homeId = ctx.homeId;
    roomMap = ctx.roomMap ?? {};
  } catch (e) {
    return {
      applied: false,
      reason: `ctx_failed:${e instanceof Error ? e.message : 'unknown'}`,
      rooms: [],
    };
  }

  const endtime = Math.floor(now / 1000) + ANTIFREEZE_ENDTIME_SEC;
  const successes: string[] = [];
  const failures: string[] = [];

  for (const key of BATHROOM_ROOM_KEYS) {
    const roomId = roomMap[key];
    if (!roomId) {
      failures.push(`${key}:no_map`);
      continue;
    }
    try {
      await setRoomState(accessToken, homeId, roomId, 'manual', ANTIFREEZE_TEMP, endtime);
      successes.push(key);
    } catch (e) {
      failures.push(`${key}:${e instanceof Error ? e.message.slice(0, 40) : 'err'}`);
    }
  }

  if (successes.length === BATHROOM_ROOM_KEYS.length) {
    state.bathroomsAntifrozenAt = now;
    return { applied: true, reason: 'antifrozen_all', rooms: successes };
  }
  if (successes.length > 0) {
    // Partial success: DON'T mark state as done so next cycle retries the
    // failed ones. The successful rooms already have a 180-day endtime so
    // they're safe; the failures will retry without spamming the successes.
    return {
      applied: true,
      reason: `antifrozen_partial:${failures.join(',')}`,
      rooms: successes,
    };
  }
  return {
    applied: false,
    reason: `antifreeze_failed:${failures.join(',')}`,
    rooms: [],
  };
}
