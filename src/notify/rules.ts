import type { DB } from '../db/index.js';
import { alertSentence } from '../alerts/index.js';
import type { TodayView } from '../today/service.js';
import { escapeHtml } from './telegram.js';
import { localDate, weekKey, addDays } from '../lib/clock.js';
import { sections, type StoredReview, type WeeklyFacts } from '../review/weekly.js';

/**
 * The notification contract (PLAN.md §8, nudge caps from DESIGN.md): at most one unprompted
 * message a day (08:00, red alerts plus the 3 actions, skipped when there is neither), one
 * push when a red alert opens and one when it closes, and the Sunday review. Silence is a
 * valid outcome.
 */

export type Send = (html: string) => Promise<void>;

interface AlertRow { id: number; kind: string; subject: string; opened_at: string; closed_at: string | null }

const KIND: Record<string, string> = {
  down: 'not responding', dns_gone: 'domain not resolving', tls_expired: 'certificate expired', tls_expiring: 'certificate expiring',
  placeholder: 'placeholder page', process_pressure: 'process limit pressure', next_build: 'Next.js build running', collector_stale: 'data not updating',
};
const duration = (from: string, to: string) => {
  const min = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return min < 90 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};

/**
 * Push each red alert once when it opens and once when it closes. An alert is marked only
 * after its message went out, so a failed send is retried on the next tick and a sent one is
 * never repeated. A red alert that opened and closed before it could be announced stays quiet.
 */
export async function pushAlerts(db: DB, send: Send, now: Date): Promise<number> {
  let sent = 0;
  const opened = db.prepare("SELECT id,kind,subject,opened_at,closed_at FROM alerts WHERE severity='red' AND notified_at IS NULL AND closed_at IS NULL ORDER BY opened_at, id").all() as AlertRow[];
  for (const a of opened) {
    await send(`🔴 <b>Broken</b>: ${escapeHtml(alertSentence(db, a, now))}`);
    db.prepare('UPDATE alerts SET notified_at=? WHERE id=?').run(now.toISOString(), a.id); sent++;
  }
  const closed = db.prepare('SELECT id,kind,subject,opened_at,closed_at FROM alerts WHERE notified_at IS NOT NULL AND closed_at IS NOT NULL AND closed_notified_at IS NULL ORDER BY closed_at, id').all() as AlertRow[];
  for (const a of closed) {
    const name = a.subject.slice(a.subject.indexOf(':') + 1);
    await send(`✅ <b>Fixed</b>: ${escapeHtml(`${name} (${KIND[a.kind] ?? a.kind}) cleared after ${duration(a.opened_at, a.closed_at!)}.`)}`);
    db.prepare('UPDATE alerts SET closed_notified_at=? WHERE id=?').run(now.toISOString(), a.id); sent++;
  }
  return sent;
}

export const openRedSentences = (db: DB, now: Date) =>
  (db.prepare("SELECT kind,subject FROM alerts WHERE severity='red' AND closed_at IS NULL ORDER BY opened_at").all() as { kind: string; subject: string }[]).map(a => alertSentence(db, a, now));

/** Red alerts plus the day's actions, or null when there is nothing to say. */
export function todayMessage(red: string[], view: Pick<TodayView, 'actions'>, title = 'Today'): string | null {
  if (!red.length && !view.actions.length) return null;
  const lines = [`<b>${escapeHtml(title)}</b>`];
  if (red.length) lines.push('', '<b>Broken</b>', ...red.map(s => `🔴 ${escapeHtml(s)}`));
  if (view.actions.length) lines.push('', '<b>Your 3 things</b>', ...view.actions.map((a, i) =>
    `${i + 1}. ${escapeHtml(a.task.title)}\n   <i>${escapeHtml(`${a.project?.name ?? a.task.repo ?? 'no project'} · ${a.reason}`)}</i>`));
  return lines.join('\n');
}

export function reviewMessage(review: Pick<StoredReview, 'headline' | 'body' | 'facts'>, url = 'http://127.0.0.1:4000/review'): string {
  const facts = JSON.parse(review.facts) as WeeklyFacts;
  const lines = [`<b>Weekly review</b>: ${escapeHtml(review.headline)}`];
  if (review.body) lines.push('', escapeHtml(review.body));
  for (const s of sections(facts)) lines.push('', `<b>${escapeHtml(s.title)}</b>`, ...(s.lines.length ? s.lines.map(l => `• ${escapeHtml(l)}`) : ['• none']));
  lines.push('', escapeHtml(url));
  return lines.join('\n');
}

/** The owner-timezone calendar date, weekday (0 = Sunday) and minutes since midnight. */
export function localClock(now: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: localDate(now, timeZone), weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
export const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** The day key the daily push is due for, or null before today's push time. */
export function dailyDue(now: Date, timeZone: string, at: string): string | null {
  const c = localClock(now, timeZone);
  return c.minutes >= minutesOf(at) ? c.date : null;
}

/**
 * The week (its Monday) whose review is due: the most recent `weekday` at `at` that has
 * passed. The app catches up once if the PC was off at that moment, and never runs twice.
 */
export function weeklyDue(now: Date, timeZone: string, weekday: number, at: string): string {
  const c = localClock(now, timeZone);
  let back = (c.weekday - weekday + 7) % 7;
  if (back === 0 && c.minutes < minutesOf(at)) back = 7;
  return weekKey(addDays(c.date, -back));
}

export function getKv(db: DB, key: string): string | null {
  return (db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setKv(db: DB, key: string, value: string, now: Date) {
  db.prepare('INSERT INTO kv(key,value,at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at').run(key, value, now.toISOString());
}
