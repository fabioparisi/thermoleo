/**
 * Persists setpoint overrides to Supabase so they survive page refresh.
 *
 * Overrides are kept until the device API confirms the new value,
 * or until a 24-hour safety TTL expires (in case of stuck data).
 */

import { providerKey } from '@/lib/supabase/rest';

const SAFETY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — hard safety limit

// Per-property `tokens` provider. Phase 5 namespacing: reads prefer the
// suffixed row and fall back to the nude one during the Phase 5→6 drain;
// writes ALWAYS target the suffixed row. Single-home today (Milano).
const PROVIDER = 'setpoint_overrides';
const PROPERTY_ID = 'milano';

export interface SetpointOverride {
  setpoint: number;
  fan?: number;
  mode?: string;
  timestamp: number;
}

export type Overrides = Record<string, SetpointOverride>;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return { url, key };
}

async function fetchOverridesRow(provider: string): Promise<Overrides | null> {
  const { url, key } = getSupabase();
  const res = await fetch(
    `${url}/rest/v1/tokens?provider=eq.${encodeURIComponent(provider)}&select=data&order=updated_at.desc&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' },
  );
  if (!res.ok) {
    console.error('[setpoint-store] loadOverrides HTTP error:', res.status, await res.text());
    return null;
  }
  const rows = await res.json();
  if (rows?.length && rows[0].data && typeof rows[0].data === 'object') {
    return rows[0].data as Overrides;
  }
  return null;
}

async function loadOverrides(): Promise<Overrides> {
  try {
    // Suffixed first; nude-fallback during the Phase 5→6 drain.
    const suffixed = await fetchOverridesRow(providerKey(PROVIDER, PROPERTY_ID));
    if (suffixed) return suffixed;
    const nude = await fetchOverridesRow(PROVIDER);
    if (nude) return nude;
  } catch (e) {
    console.error('[setpoint-store] loadOverrides error:', e);
  }
  return {};
}

async function storeOverrides(overrides: Overrides): Promise<void> {
  try {
    const { url, key } = getSupabase();
    const body = { provider: providerKey(PROVIDER, PROPERTY_ID), data: overrides, updated_at: new Date().toISOString() };
    const res = await fetch(`${url}/rest/v1/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('[setpoint-store] storeOverrides HTTP error:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[setpoint-store] storeOverrides error:', e);
  }
}

export async function saveSetpointOverride(
  roomId: string,
  setpoint: number,
  fan?: number,
  mode?: string,
): Promise<void> {
  const overrides = await loadOverrides();
  overrides[roomId] = { setpoint, fan, mode, timestamp: Date.now() };
  await storeOverrides(overrides);
  console.log(`[setpoint-store] saved override for ${roomId}: setpoint=${setpoint} fan=${fan} mode=${mode}`);
}

/**
 * Returns all active overrides (only 24h safety TTL).
 * Does NOT auto-expire — removal is handled by confirmDeviceValues().
 */
export async function getActiveOverrides(): Promise<Overrides> {
  const overrides = await loadOverrides();
  const now = Date.now();
  const active: Overrides = {};
  let hasExpired = false;

  for (const [roomId, override] of Object.entries(overrides)) {
    if (now - override.timestamp < SAFETY_TTL_MS) {
      active[roomId] = override;
    } else {
      hasExpired = true;
      console.log(`[setpoint-store] 24h safety TTL expired for ${roomId}`);
    }
  }

  if (hasExpired) {
    await storeOverrides(active);
  }

  return active;
}

/**
 * Removes overrides for rooms where the device has confirmed the new value.
 * Call this from /api/rooms after comparing device vs override setpoints.
 */
export async function confirmDeviceValues(
  confirmedRoomIds: string[],
): Promise<void> {
  if (confirmedRoomIds.length === 0) return;

  const overrides = await loadOverrides();
  let changed = false;
  for (const roomId of confirmedRoomIds) {
    if (overrides[roomId]) {
      console.log(`[setpoint-store] device confirmed value for ${roomId}, removing override`);
      delete overrides[roomId];
      changed = true;
    }
  }
  if (changed) {
    await storeOverrides(overrides);
  }
}
