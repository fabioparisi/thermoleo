import { authenticate, renewToken } from './client';
import type { SabianaAuthTokens, SabianaJWT } from './types';

let cachedTokens: SabianaAuthTokens | null = null;

const TOKEN_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

function isExpired(jwt: SabianaJWT): boolean {
  return Date.now() >= jwt.expiresAt.getTime() - TOKEN_MARGIN_MS;
}

export async function getValidToken(): Promise<string> {
  // First call: authenticate from scratch
  if (!cachedTokens) {
    const email = process.env.SABIANA_EMAIL;
    const password = process.env.SABIANA_PASSWORD;
    if (!email || !password) throw new Error('SABIANA_EMAIL and SABIANA_PASSWORD required');
    cachedTokens = await authenticate(email, password);
    return cachedTokens.shortJwt.token;
  }

  // Short JWT still valid
  if (!isExpired(cachedTokens.shortJwt)) {
    return cachedTokens.shortJwt.token;
  }

  // Short JWT expired, long JWT still valid → renew
  if (!isExpired(cachedTokens.longJwt)) {
    try {
      const newShort = await renewToken(cachedTokens.longJwt.token);
      cachedTokens = { ...cachedTokens, shortJwt: newShort };
      return newShort.token;
    } catch {
      // Renewal failed, fall through to full re-auth
    }
  }

  // Both expired → full re-auth
  const email = process.env.SABIANA_EMAIL;
  const password = process.env.SABIANA_PASSWORD;
  if (!email || !password) throw new Error('SABIANA_EMAIL and SABIANA_PASSWORD required');
  cachedTokens = await authenticate(email, password);
  return cachedTokens.shortJwt.token;
}
