/**
 * Milano heating-calendar logic.
 *
 * Default schedule per DPR 412/93, zona climatica E (Milano):
 *   - heat: 15-ott → 15-apr (incluso)
 *   - off:  16-apr → 14-ott
 *
 * 'cool' is NEVER produced by the calendar: condominio chiller activation
 * is unpredictable (depends on board decision + weather), so cool is
 * always opt-in via manual override.
 *
 * Overrides win over the calendar when the current date is within
 * [start, end] inclusive. They expire automatically — no maintenance
 * needed when an ordinanza window closes.
 *
 * All functions are PURE: deterministic, no I/O, easy to unit-test
 * via the `now` parameter.
 */

import type { Season } from './season';

export interface SeasonOverride {
  season: Season;
  /** ISO date YYYY-MM-DD, inclusive. */
  start: string;
  /** ISO date YYYY-MM-DD, inclusive. */
  end: string;
  reason: string;
}

export type SeasonSource = 'calendar' | 'override';

export interface ResolvedSeason {
  season: Season;
  source: SeasonSource;
  reason: string;
}

/**
 * Heating-on date (inclusive). Day-of-month >= 15 in October counts.
 */
const HEAT_START_MONTH = 10;
const HEAT_START_DAY = 15;
/**
 * Heating-off date (inclusive end of heat). Day-of-month <= 15 in April counts.
 */
const HEAT_END_MONTH = 4;
const HEAT_END_DAY = 15;

/**
 * Get the date in Europe/Rome timezone as { year, month, day } so the
 * 15-ott / 15-apr boundaries match the local calendar regardless of
 * server timezone (Vercel = UTC).
 */
function localCalendar(now: Date): { month: number; day: number } {
  // Format the date in Europe/Rome and parse the month/day fields.
  // toLocaleDateString with timeZone is the only stdlib path that's
  // fully reliable across Node 22+ runtimes.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const day = Number(parts.find((p) => p.type === 'day')!.value);
  return { month, day };
}

/**
 * Calendar-derived season for the given date (in Europe/Rome).
 *
 * Returns 'heat' inside the legal Milano heating window (15-ott → 15-apr,
 * cross-year), 'off' otherwise. Never returns 'cool' — that's an opt-in
 * override decision (chiller activation).
 */
export function calendarSeason(now: Date = new Date()): Season {
  const { month, day } = localCalendar(now);

  // Heat window crosses year boundary.
  // Branch 1: from HEAT_START_MONTH/DAY through end of December.
  if (month > HEAT_START_MONTH) return 'heat';
  if (month === HEAT_START_MONTH && day >= HEAT_START_DAY) return 'heat';
  // Branch 2: from start of January through HEAT_END_MONTH/DAY.
  if (month < HEAT_END_MONTH) return 'heat';
  if (month === HEAT_END_MONTH && day <= HEAT_END_DAY) return 'heat';
  return 'off';
}

/**
 * True if `now` (in Europe/Rome) falls inside the override window
 * [start, end] inclusive. Override dates are stored as YYYY-MM-DD with
 * Italian semantics (a date string '2026-04-25' is interpreted as that
 * full local day in Europe/Rome).
 */
export function overrideActive(override: SeasonOverride, now: Date = new Date()): boolean {
  const today = isoLocalDate(now);
  return today >= override.start && today <= override.end;
}

/** YYYY-MM-DD in Europe/Rome local time. */
export function isoLocalDate(now: Date = new Date()): string {
  const { month, day } = localCalendar(now);
  // Get year separately (formatToParts is enough for full date).
  const year = Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
    }).format(now),
  );
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Resolve the effective season for the agent.
 *
 * Priority:
 *   1. If override is set AND today is in [override.start, override.end]
 *      → use override.season (source='override').
 *   2. Else → use calendarSeason() (source='calendar').
 *
 * Override expiration is the caller's job — `season-tick` should detect
 * an expired override and clear it from the DB.
 */
export function resolveSeason(
  override: SeasonOverride | null,
  now: Date = new Date(),
): ResolvedSeason {
  if (override && overrideActive(override, now)) {
    return {
      season: override.season,
      source: 'override',
      reason: `override: ${override.reason} (${override.start}→${override.end})`,
    };
  }
  const cal = calendarSeason(now);
  return {
    season: cal,
    source: 'calendar',
    reason: cal === 'heat'
      ? `Calendario Milano (zona E): finestra riscaldamento 15-ott→15-apr`
      : `Calendario Milano (zona E): fuori finestra riscaldamento (16-apr→14-ott)`,
  };
}

/**
 * True if the override exists but its end date is strictly before today
 * (Europe/Rome). Caller should null it out + log a transition.
 */
export function overrideExpired(override: SeasonOverride | null, now: Date = new Date()): boolean {
  if (!override) return false;
  const today = isoLocalDate(now);
  return today > override.end;
}

/**
 * Italian-friendly transition message for the alert.
 */
export function transitionMessage(
  from: Season,
  to: Season,
  resolved: ResolvedSeason,
): string {
  return `🌡️ Stagione: ${from} → ${to}. ${resolved.reason}`;
}
