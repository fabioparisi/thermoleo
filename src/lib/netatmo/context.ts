/**
 * Shared loader for Netatmo homeId + roomMap context stored in the
 * `tokens` Supabase table.
 *
 * Five route handlers (agent/cycle, netatmo/status, netatmo/setpoint,
 * rooms, rooms/[id]) all perform the same two parallel fetches. This
 * module centralises them so changes to the storage schema only need to
 * be made once.
 */

import { supaGetTokenData } from '@/lib/supabase/rest';
import type { NetatmoHomeData, NetatmoRoomMapData } from '@/lib/supabase/types';

export interface NetatmoContext {
  homeId: string | null;
  roomMap: Record<string, string> | null;
}

export interface NetatmoContextStrict {
  homeId: string;
  roomMap: Record<string, string>;
}

/**
 * Load Netatmo homeId and roomMap in parallel from the tokens table.
 *
 * Returns `null` for whichever side is missing from the DB.
 * Never throws — any network / HTTP errors are surfaced as `null` values.
 */
export async function loadNetatmoContext(): Promise<NetatmoContext> {
  try {
    const [homeData, roomMap] = await Promise.all([
      supaGetTokenData<NetatmoHomeData>('netatmo_home'),
      supaGetTokenData<NetatmoRoomMapData>('netatmo_room_map'),
    ]);
    return {
      homeId: homeData?.home_id ?? null,
      roomMap: roomMap ?? null,
    };
  } catch {
    return { homeId: null, roomMap: null };
  }
}

/**
 * Like `loadNetatmoContext()` but throws `Error('netatmo_context_missing')`
 * if either homeId or roomMap is absent, so callers that require both can
 * fail-fast without nested null checks.
 */
export async function loadNetatmoContextStrict(): Promise<NetatmoContextStrict> {
  const ctx = await loadNetatmoContext();
  if (!ctx.homeId || !ctx.roomMap) {
    throw new Error('netatmo_context_missing');
  }
  return { homeId: ctx.homeId, roomMap: ctx.roomMap };
}
