const DAY = 86_400_000;
export function localDate(at: number | Date, timeZone = 'America/Asuncion'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
export const today = (timeZone = 'America/Asuncion', now = Date.now()) => localDate(now, timeZone);
export const dateValue = (date: string) => Date.parse(`${date}T12:00:00Z`);
export const weekdayOf = (date: string) => new Date(dateValue(date)).getUTCDay();
export const daysBetween = (a: string, b: string) => Math.round((dateValue(a) - dateValue(b)) / DAY);
export const addDays = (date: string, days: number) => new Date(dateValue(date) + days * DAY).toISOString().slice(0, 10);
export const weekKey = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));
export function safeTimeZone(zone: string | null | undefined): string {
  try { if (zone) { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } } catch { /* use UTC */ }
  return 'UTC';
}
export function localDateOf(value: Date | string | null | undefined, zone: string): string | null {
  if (value == null) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(instant) ? null : localDate(instant, zone);
}
