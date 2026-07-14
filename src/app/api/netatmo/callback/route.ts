import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode, getHomesData } from '@/lib/netatmo/client';
import { saveTokens } from '@/lib/netatmo/token-store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netatmo/callback — OAuth callback handler.
 * Exchanges authorization code for tokens, discovers home_id, persists everything.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ ok: false, error: 'Missing code parameter' }, { status: 400 });
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCode(code);
    await saveTokens(tokens);

    // Discover home_id and save it
    const homesData = await getHomesData(tokens.access_token);
    const home = homesData.homes?.[0];

    // Save home_id to Supabase settings
    if (home) {
      const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
      await fetch(`${SUPABASE_URL}/rest/v1/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          provider: 'netatmo_home',
          data: { home_id: home.id, home_name: home.name, rooms: home.rooms?.map((r) => ({ id: r.id, name: r.name })) },
          updated_at: new Date().toISOString(),
        }),
      });
    }

    // Redirect to dashboard with success message
    return NextResponse.redirect(new URL('/?netatmo=ok', req.nextUrl.origin));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
