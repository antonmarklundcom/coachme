/**
 * nudge.ts — run the daily nudge by hand.
 *
 *   npm run nudge              # decide, record, and deliver
 *   npm run nudge -- --dry-run # decide and record, never deliver
 *   npm run nudge -- 2026-08-30  # ...as if it were that owner-local date
 *
 * The same code path the Vercel Cron hits, minus the HTTP layer — so a session
 * with no CRON_SECRET can still exercise the ladder end to end.
 */

import { loadEnv } from './env';
import { closePool } from '../lib/db';
import { runNudge } from '../lib/nudge/run';

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const date = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dryRun = argv.includes('--dry-run');

  const result = await runNudge({ source: 'manual', date, dryRun });

  console.log(`\n${result.date} (${result.timezone}) — ${result.decision.push ? 'PUSH' : 'silent'}`);
  console.log(`  reason: ${result.decision.reason}`);
  if (result.decision.title) console.log(`  ${result.decision.title}\n  ${result.decision.body}`);
  if (result.decision.repos.length) console.log(`  repos: ${result.decision.repos.join(', ')}`);
  if (result.resolved.length) {
    console.log(`  resolved ${result.resolved.length} earlier nudge(s): ` +
      result.resolved.map((r) => `#${r.id}→${r.outcome}`).join(', '));
  }
  if (result.push) {
    console.log(
      `  push: ${result.push.skipped ? `skipped (${result.push.skipped})` : `${result.push.sent} sent, ${result.push.failed} failed, ${result.push.pruned} pruned`}`
    );
  }
  console.log();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
