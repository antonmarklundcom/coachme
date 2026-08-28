/**
 * queue.ts — print the ranked launch queue and the proposed DB batches from
 * Neon. The CLI equivalent of the old `node src/score.js`, kept because a
 * session debugging the coach should be able to see what it thinks without
 * opening a browser.
 *
 *   npm run queue
 *   npm run queue -- --batches
 *   npm run queue -- --json
 */

import { loadEnv } from './env';
import { closePool } from '../lib/db';
import { getQueues } from '../lib/queries';
import { validateCoefficients, type ScoredRepo } from '../lib/score';

function line(entry: ScoredRepo): string {
  return (
    `${entry.repo.name.padEnd(22)} ${String(entry.repo.pct).padStart(3)}%  ` +
    `${entry.repo.blocker.padEnd(26)} ${String(entry.minutes).padStart(2)}min  ` +
    `score ${entry.total.toFixed(1).padStart(6)}` +
    (entry.unblocks.length ? `  → unblocks ${entry.unblocks.join(', ')}` : '')
  );
}

async function main() {
  loadEnv();
  validateCoefficients();
  const argv = process.argv.slice(2);
  const { queue, batches } = await getQueues();

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          queue: queue.map((e) => ({ repo: e.repo.name, pct: e.repo.pct, blocker: e.repo.blocker, score: e.total })),
          batches: batches.map((b) => ({ key: b.key, repos: b.repos, minutes: b.minutes })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\nLAUNCH QUEUE — ${queue.length} owner-blocked repos at ≥70%\n`);
  queue.forEach((e, i) => console.log(`${String(i + 1).padStart(2)}. ${line(e)}`));

  const shown = argv.includes('--batches') ? batches : batches.slice(0, 1);
  console.log(`\nPROPOSED DB SESSION${shown.length > 1 ? 'S' : ''} — ${batches.length} batch(es) available\n`);
  for (const b of shown) {
    const n = b.repos.length;
    console.log(`  ${b.minutes} min unblocks ${n} launch${n === 1 ? '' : 'es'}: ${b.repos.join(', ')}  [${b.key}]`);
    for (const e of b.entries) console.log(`      · ${line(e)}`);
  }
  const total = batches.reduce((s, b) => s + b.minutes, 0);
  console.log(`\n  Whole DB backlog: ${batches.length} sittings, ~${(total / 60).toFixed(1)}h of hPanel time.\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
