/**
 * Homey OAuth2 — callback.
 * Athom redirects here with ?code=... after user consent.
 * We exchange the code for tokens and persist them in Supabase.
 */

import { NextResponse } from 'next/server';
import { exchangeCodeForTokens, checkHomeyHealth } from '@/lib/homey/client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new NextResponse(
      `<h1>Homey OAuth error</h1><p>${error}: ${url.searchParams.get('error_description') ?? ''}</p>`,
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    );
  }
  if (!code) {
    return new NextResponse('<h1>Missing code parameter</h1>', {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const redirectUri = `${url.origin}/api/auth/homey/callback`;
  const exchanged = await exchangeCodeForTokens(code, redirectUri);

  if (!exchanged.ok) {
    return new NextResponse(
      `<h1>Token exchange failed</h1>
       <p><strong>Reason:</strong> ${exchanged.error ?? 'unknown'}</p>
       <p>Probable causes: expired code (10min TTL), wrong redirect_uri match in Athom dev console, invalid client secret.</p>
       <p><a href="/api/auth/homey/start">Try again</a></p>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    );
  }

  const health = await checkHomeyHealth();
  const healthy = health.ok;
  const body = `
    <html>
      <body style="font-family: system-ui; padding: 2rem; max-width: 640px;">
        <h1>${healthy ? 'Homey connected' : 'Token saved, but health check failed'}</h1>
        <p><strong>Refresh token saved.</strong> The agent will auto-refresh forever.</p>
        <p>Sensors detected: <strong>${health.sensorCount ?? 0}</strong></p>
        ${healthy ? '' : `<p style="color:#c00">Reason: ${health.reason ?? 'unknown'}</p>`}
        <p><a href="/">← Back to dashboard</a></p>
      </body>
    </html>
  `;
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}
