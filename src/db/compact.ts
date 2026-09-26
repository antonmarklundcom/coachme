import type { DB } from './index.js';

/**
 * Observation tables grow by about 10k rows a day (snapshots every 10-30 minutes). History
 * older than `days` is thinned to the last observation per subject per day, which is all the
 * trends and the review need. Recent history and the latest row per subject are never touched.
 */
const TABLES = [['gh_snapshots', 'repo'], ['local_snapshots', 'path'], ['domain_checks', 'host'], ['process_samples', 'account_id']] as const;

export function compact(db: DB, now: Date, days = 30): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  let removed = 0;
  db.transaction(() => {
    for (const [table, subject] of TABLES) {
      removed += db.prepare(`DELETE FROM ${table} WHERE at < ? AND id NOT IN (SELECT max(id) FROM ${table} WHERE at < ? GROUP BY ${subject}, substr(at,1,10))`).run(cutoff, cutoff).changes;
    }
  })();
  db.pragma('optimize');
  return removed;
}
