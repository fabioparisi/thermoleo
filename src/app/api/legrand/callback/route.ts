import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/legrand/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/legrand/callback — Works with Legrand OAuth2 redirect target.
 *
 * If LEGRAND_CLIENT_ID/SECRET/SUBSCRIPTION_KEY env vars are set (i.e. the
 * app has been approved on developer.legrand.com), exchange the code for
 * tokens and persist them in Supabase `tokens` (provider='legrand').
 *
 * If env vars are not set yet (e.g. first OAuth consent before going live),
 * just save the authorization code so it can be exchanged manually later.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const error = req.nextUrl.searchParams.get('error');
  const errorDescription = req.nextUrl.searchParams.get('error_description');

  if (error) {
    return NextResponse.json(
      { ok: false, error, error_description: errorDescription },
      { status: 400 },
    );
  }
  if (!code) {
    return NextResponse.json({ ok: false, error: 'Missing code parameter' }, { status: 400 });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const credsReady = !!(
    process.env.LEGRAND_CLIENT_ID &&
    process.env.LEGRAND_CLIENT_SECRET &&
    process.env.LEGRAND_SUBSCRIPTION_KEY &&
    process.env.LEGRAND_REDIRECT_URI
  );

  if (!credsReady) {
    // Stub mode: persist the code for later manual exchange.
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          provider: 'legrand_pending_code',
          data: { code, state, received_at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        }),
      });
    } catch {
      /* non-fatal */
    }
    // Do NOT echo the one-time `code` or `state` back to the caller — those
    // values could be captured by Vercel log drains, browser history, or
    // downstream proxies. The values live in Supabase (provider
    // 'legrand_pending_code') for the operator to consume server-side.
    return NextResponse.json({
      ok: true,
      mode: 'stub',
      message: 'Authorization code captured server-side. Configure LEGRAND_CLIENT_ID/SECRET/SUBSCRIPTION_KEY to enable full token exchange.',
    });
  }

  // Full mode: exchange the code for tokens and persist them.
  try {
    const tokens = await exchangeCode(code);
    await fetch(`${SUPABASE_URL}/rest/v1/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        provider: 'legrand',
        data: tokens,
        updated_at: new Date().toISOString(),
      }),
    });
    // Redirect to dashboard so the user sees a friendly landing page.
    return NextResponse.redirect(new URL('/?legrand=ok', req.nextUrl.origin));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
