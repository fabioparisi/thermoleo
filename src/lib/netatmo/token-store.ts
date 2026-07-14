/**
 * Netatmo token persistence via Supabase tokens table.
 * Handles automatic refresh when tokens are about to expire.
 */

import type { NetatmoTokens } from './client';
import { refreshTokens } from './client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const PROVIDER = 'netatmo';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// In-memory cache to avoid hitting Supabase every request
let cachedTokens: NetatmoTokens | null = null;
// Simple lock to prevent concurrent refresh attempts
let refreshPromise: Promise<NetatmoTokens> | null = null;

async function supabaseRequest(method: string, path: string, body?: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

/**
 * Save tokens to Supabase and update cache.
 */
export async function saveTokens(tokens: NetatmoTokens): Promise<void> {
  cachedTokens = tokens;
  await supabaseRequest('POST', 'tokens', {
    provider: PROVIDER,
    data: tokens,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Load tokens from Supabase (or cache).
 */
export async function loadTokens(): Promise<NetatmoTokens | null> {
  if (cachedTokens) return cachedTokens;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tokens?provider=eq.${PROVIDER}&select=data`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    },
  );
  const rows = await res.json();
  if (!rows?.length) return null;

  cachedTokens = rows[0].data as NetatmoTokens;
  return cachedTokens;
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no tokens are stored (user hasn't authenticated yet).
 */
export async function getValidAccessToken(): Promise<string | null> {
  let tokens = await loadTokens();
  if (!tokens) return null;

  // Check if token needs refresh
  if (Date.now() > tokens.expires_at - REFRESH_MARGIN_MS) {
    // Use a shared promise to prevent concurrent refresh attempts
    if (!refreshPromise) {
      refreshPromise = refreshTokens(tokens.refresh_token);
    }
    try {
      tokens = await refreshPromise;
      await saveTokens(tokens);
    } catch (e) {
      console.error('Netatmo token refresh failed:', e);
      cachedTokens = null;
      return null;
    } finally {
      refreshPromise = null;
    }
  }

  return tokens.access_token;
}

/**
 * Clear stored tokens (for logout/re-auth).
 */
export async function clearTokens(): Promise<void> {
  cachedTokens = null;
  await supabaseRequest('DELETE', `tokens?provider=eq.${PROVIDER}`);
}
