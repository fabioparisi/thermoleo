/**
 * Homey OAuth2 — start authorization flow.
 * GET /api/auth/homey/start → redirect to Athom consent page.
 * After user approves, Athom redirects to /api/auth/homey/callback.
 *
 * Visit this once per Homey to obtain the long-lived refresh token.
 * After that, the agent auto-refreshes forever (provided HOMEY_CLIENT_SECRET
 * is set).
 */

import { NextResponse } from 'next/server';
import { buildAuthorizeUrl } from '@/lib/homey/client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Build absolute callback URL using the request's own origin so it works on
  // Vercel previews and localhost without env wiring.
  const redirectUri = `${url.origin}/api/auth/homey/callback`;
  const authorizeUrl = buildAuthorizeUrl(redirectUri, 'thermoleo');
  return NextResponse.redirect(authorizeUrl);
}
