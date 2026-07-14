/**
 * Homey health check.
 * Used by external monitoring (cron-job.org, UptimeRobot) and the dashboard badge.
 *
 * Behavior:
 * - GET → JSON {ok, reason, sensorCount, lastReadingMin}
 * - When called with ?alert=1: sends iMessage if Homey has been down for >10min,
 *   rate-limited (one alert per hour).
 *
 * Cron suggestion: every 10 minutes, hit /api/health/homey?alert=1
 */

import { NextResponse } from 'next/server';
import { checkHomeyHealth } from '@/lib/homey/client';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const IMESSAGE_PROXY_URL = process.env.IMESSAGE_PROXY_URL || 'http://localhost:9100';
const IMESSAGE_RECIPIENT = process.env.IMESSAGE_RECIPIENT || 'fabioparisi@me.com';
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between Homey down alerts

function supaHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
}

async function getLastAlertAt(): Promise<number> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/alerts?room_id=eq._homey&order=triggered_at.desc&limit=1&select=triggered_at`,
      { headers: supaHeaders(), signal: AbortSignal.timeout(5000) },
    );
    const rows = await res.json();
    if (rows?.length) return new Date(rows[0].triggered_at).getTime();
  } catch { /* silent */ }
  return 0;
}

async function sendAlert(reason: string) {
  // Log to Supabase
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/alerts`, {
      method: 'POST',
      headers: { ...supaHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify([{
        room_id: '_homey',
        alert_type: 'homey_down',
        severity: 'critical',
        message: `Homey API down: ${reason}. Visit /api/auth/homey/start to re-authorize.`,
        notified_via: ['log', 'imessage'],
      }]),
    });
  } catch { /* silent */ }

  // Send iMessage
  try {
    await fetch(`${IMESSAGE_PROXY_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: IMESSAGE_RECIPIENT,
        message: `ThermoLeo [CRITICAL]: Homey API down (${reason}). Sensors leone/studio fallback degraded. Visita https://thermoleo-app.vercel.app/api/auth/homey/start per ri-autorizzare.`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* silent — iMessage proxy may be off */ }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const shouldAlert = url.searchParams.get('alert') === '1';

  const health = await checkHomeyHealth();

  // Cross-check with sonoff_bridge freshness as a second signal
  let bridgeAgeMin: number | null = null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sonoff_bridge?select=updated_at&order=updated_at.desc&limit=1`,
      { headers: supaHeaders(), signal: AbortSignal.timeout(5000) },
    );
    const rows = await res.json();
    if (rows?.length) {
      bridgeAgeMin = (Date.now() - new Date(rows[0].updated_at).getTime()) / 60000;
    }
  } catch { /* silent */ }

  // Both Homey AND bridge dead = real problem worth alerting on
  const homeyDown = !health.ok;
  const bridgeDead = bridgeAgeMin === null || bridgeAgeMin > 10;
  const shouldFire = homeyDown && bridgeDead;

  if (shouldAlert && shouldFire) {
    const lastAlertAt = await getLastAlertAt();
    const cooldownExpired = Date.now() - lastAlertAt > ALERT_COOLDOWN_MS;
    if (cooldownExpired) {
      await sendAlert(health.reason ?? 'unknown');
    }
  }

  return NextResponse.json({
    ok: health.ok && !bridgeDead,
    homey: health,
    bridge: { ageMinutes: bridgeAgeMin, ok: !bridgeDead },
    timestamp: new Date().toISOString(),
  }, {
    status: shouldFire ? 503 : 200,
  });
}
