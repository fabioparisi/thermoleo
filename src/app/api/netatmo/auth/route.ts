import { redirect } from 'next/navigation';
import { getAuthUrl } from '@/lib/netatmo/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netatmo/auth — redirect user to Netatmo OAuth login page.
 */
export async function GET() {
  const url = getAuthUrl();
  redirect(url);
}
