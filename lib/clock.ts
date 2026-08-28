/**
 * clock.ts — the owner's day.
 *
 * Every cap in DESIGN.md §3 ("max 1 push/day", "max 5/week", "Sunday is always
 * silent") is counted in the owner's local day, which is not UTC: Asunción is
 * permanently UTC-3, so anything after 21:00 local is already tomorrow in UTC.
 * plan.md §2 is explicit that the caps are evaluated in the timezone stored in
 * `settings`, so the conversion lives here rather than being open-coded.
 *
 * Pure: the only clock is the one passed in.
 */

/** `YYYY-MM-DD` for an instant, as seen in `timeZone`. */
export function localDate(at: number | Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the shape the rest of the app uses.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

const DAY = 24 * 60 * 60 * 1000;

/** Midday UTC on a `YYYY-MM-DD`, the app's stable anchor for date arithmetic. */
export function dateValue(date: string): number {
  return Date.parse(`${date}T12:00:00Z`);
}

/** 0 = Sunday. Derived from the date string itself, so it needs no timezone. */
export function weekdayOf(date: string): number {
  return new Date(dateValue(date)).getUTCDay();
}

/** Whole days from `b` to `a`, both `YYYY-MM-DD`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateValue(a) - dateValue(b)) / DAY);
}

export function addDays(date: string, days: number): string {
  return new Date(dateValue(date) + days * DAY).toISOString().slice(0, 10);
}

/**
 * Monday-anchored week key, so "max 5 per week" means one stable thing rather
 * than a rolling window that a Sunday could reset twice.
 */
export function weekKey(date: string): string {
  const d = new Date(dateValue(date));
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/** Does `timeZone` name a zone this runtime knows? Falls back rather than throwing. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
    return timeZone;
  } catch {
    console.warn(`[clock] unknown timezone "${timeZone}" — falling back to UTC`);
    return 'UTC';
  }
}

/**
 * `YYYY-MM-DD` for whatever the database handed back, in the owner's timezone.
 *
 * This exists because `pg` parses `TIMESTAMPTZ` into a JS `Date`, and
 * `String(new Date()).slice(0, 10)` is `"Fri Aug 28"` — not a date this app can
 * do arithmetic on. Every comparison downstream then silently evaluates to
 * `false` through `NaN`, which is the worst kind of bug: the coach simply stops
 * mentioning things, and nothing anywhere errors.
 */
export function localDateOf(value: Date | string | null | undefined, timeZone: string): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : localDate(value, timeZone);
  }
  // Already a plain `YYYY-MM-DD` (a Postgres DATE via to_char): it carries no
  // time, so there is no zone to convert and reinterpreting it would shift it.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : localDate(parsed, timeZone);
}
