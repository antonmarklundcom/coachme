import type { DB } from '../db/index.js';
import type { Logger } from '../lib/log.js';
import { redact } from '../lib/redact.js';
import type { AiDeps } from '../ai/client.js';
import { buildToday, type TodayDeps } from '../today/service.js';
import { generateReview, type StoredReview } from '../review/weekly.js';
import { dailyDue, getKv, openRedSentences, pushAlerts, reviewMessage, setKv, todayMessage, weeklyDue, type Send } from './rules.js';
import { addDays, localDate } from '../lib/clock.js';
import { backupDb } from '../lib/backup.js';
import { compact } from '../db/compact.js';

export interface NotifyConfig { daily_at: string; weekly_weekday: number; weekly_at: string }
export interface RhythmDeps { db: DB; ai: AiDeps; today: TodayDeps; timeZone: string; notify: NotifyConfig; now: () => Date; log: Logger; send: Send | null; reviewUrl?: string; backupDir?: string }

/** Red alerts plus the day's 3 actions as a Telegram message, or null on an empty day. */
export async function todayText(deps: Pick<RhythmDeps, 'db' | 'today' | 'now'>, title = 'Today'): Promise<string | null> {
  const view = await buildToday(deps.today);
  return todayMessage(openRedSentences(deps.db, deps.now()), view, title);
}

/** Send a stored review and record when it went out. */
export async function sendReview(db: DB, send: Send, review: StoredReview, now: Date, url?: string) {
  await send(reviewMessage(review, url));
  db.prepare('UPDATE reviews SET sent_at=? WHERE id=?').run(now.toISOString(), review.id);
}

/**
 * One pass of the rhythm, run every minute: alert pushes, the 08:00 daily push, and the
 * Sunday review. The review is generated and stored even without Telegram; pushes need it.
 * Each step records its key only after it succeeded, so a failure is retried next pass.
 */
export async function rhythmTick(deps: RhythmDeps) {
  const { db, send } = deps, now = deps.now();
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (error) { deps.log.warn(redact(`Rhythm ${name}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300)); }
  };
  if (send) await step('alerts', async () => { await pushAlerts(db, send, now); });
  if (send) await step('daily', async () => {
    const day = dailyDue(now, deps.timeZone, deps.notify.daily_at);
    if (!day || getKv(db, 'daily_push') === day) return;
    const text = await todayText(deps);
    if (text) await send(text); // an empty day is skipped: silence is a valid outcome
    setKv(db, 'daily_push', day, now);
  });
  // Daily database backup to data/backups (kept 14 days), then thinning of old snapshots,
  // on the first tick of each local day. The backup runs first so nothing is lost unseen.
  if (deps.backupDir) await step('backup', async () => {
    const day = localDate(now, deps.timeZone);
    if (getKv(db, 'backup_day') === day) return;
    await backupDb(db, deps.backupDir!, now, deps.timeZone);
    compact(db, now);
    setKv(db, 'backup_day', day, now);
  });
  await step('weekly', async () => {
    const week = weeklyDue(now, deps.timeZone, deps.notify.weekly_weekday, deps.notify.weekly_at);
    let review = db.prepare('SELECT * FROM reviews WHERE week=?').get(week) as StoredReview | undefined;
    if (!review) {
      if (getKv(db, 'weekly_review') === week) return;
      // Catch up once if the PC was off at review time, but not days later (the week has moved on).
      const due = addDays(week, deps.notify.weekly_weekday === 0 ? 6 : deps.notify.weekly_weekday - 1);
      if (Date.parse(`${addDays(due, 3)}T00:00:00Z`) < now.getTime()) { setKv(db, 'weekly_review', week, now); return; }
      review = await generateReview(db, deps.ai, now, deps.timeZone, week);
      setKv(db, 'weekly_review', week, now);
    }
    if (send && !review.sent_at) await sendReview(db, send, review, now, deps.reviewUrl);
  });
}

export function startRhythm(deps: RhythmDeps) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    rhythmTick(deps).catch(e => deps.log.error(redact(String(e)))).finally(() => { running = false; });
  };
  const timer = setInterval(tick, 60_000);
  tick();
  return { stop() { clearInterval(timer); } };
}
