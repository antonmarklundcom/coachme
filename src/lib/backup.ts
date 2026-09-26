import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { localDate } from './clock.js';

/**
 * A consistent copy of data/coach.db (SQLite online backup, safe while the server writes),
 * one file per day in data/backups/ (git-ignored), keeping the newest `keep`.
 */
export async function backupDb(db: DB, dir: string, now: Date, timeZone: string, keep = 14): Promise<{ path: string; removed: string[] }> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `coach-${localDate(now, timeZone)}.db`);
  await db.backup(path);
  const files = readdirSync(dir).filter(f => /^coach-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse();
  const removed = files.slice(Math.max(1, keep));
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return { path, removed };
}
