/**
 * seed.ts — the one-time migration of the JSON state of record into Neon.
 *
 *   npm run seed            # migrate data/*.json into the database
 *   npm run seed -- --check # count rows and spot-check, change nothing
 *
 * This is a migration, not a re-audit (plan.md §1): the 2026-08 baseline audit
 * still counts as every repo's last scan. Every field travels — including the
 * graph fields (`unblocks`, `depends_on`, `related`, `notes`) that feed
 * `unblock_weight`, and `cleared_blockers`, which is the only way the drift
 * guard can tell an owner tick from a stale estimate. Dropping either would
 * silently gut the coach.
 *
 * Re-runnable: repos upsert by name, decisions by id, stacks by repo, settings
 * is one row. Nudge history is only inserted when the table is empty, so a
 * second run cannot duplicate the anti-annoyance state machine's memory.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './env';
import { closePool, one, query } from '../lib/db';

const OWNER = 'antonmarklundcom';
const DATA = join(process.cwd(), 'data');
const read = (file: string) => JSON.parse(readFileSync(join(DATA, file), 'utf8'));

type Json = Record<string, unknown>;

async function seedRepos(portfolio: Json): Promise<number> {
  const repos = portfolio.repos as Json[];
  for (const repo of repos) {
    await query(
      `INSERT INTO repos (
         name, github_full_name, pct, lane, blocker, tier, hostinger_account, market,
         next_step, open_prs, merged_prs_30d, live_url, live_url_ok, launched_at,
         unblocks, depends_on, related, unblocks_revenue, notes, cleared_blockers,
         snoozed_until, scope_review_due, scope_review_proposed, scope_reviews_unanswered,
         kept_at, killed_at, last_commit_at, pushed_at, last_scan_at, last_scan_head_sha,
         blocked_scans, newly_blocked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       ON CONFLICT (name) DO UPDATE SET
         github_full_name = EXCLUDED.github_full_name, pct = EXCLUDED.pct,
         lane = EXCLUDED.lane, blocker = EXCLUDED.blocker, tier = EXCLUDED.tier,
         hostinger_account = EXCLUDED.hostinger_account, market = EXCLUDED.market,
         next_step = EXCLUDED.next_step, open_prs = EXCLUDED.open_prs,
         merged_prs_30d = EXCLUDED.merged_prs_30d, live_url = EXCLUDED.live_url,
         live_url_ok = EXCLUDED.live_url_ok, launched_at = EXCLUDED.launched_at,
         unblocks = EXCLUDED.unblocks, depends_on = EXCLUDED.depends_on,
         related = EXCLUDED.related, unblocks_revenue = EXCLUDED.unblocks_revenue,
         notes = EXCLUDED.notes, cleared_blockers = EXCLUDED.cleared_blockers,
         snoozed_until = EXCLUDED.snoozed_until, scope_review_due = EXCLUDED.scope_review_due,
         scope_review_proposed = EXCLUDED.scope_review_proposed,
         scope_reviews_unanswered = EXCLUDED.scope_reviews_unanswered,
         kept_at = EXCLUDED.kept_at, killed_at = EXCLUDED.killed_at,
         last_commit_at = EXCLUDED.last_commit_at, pushed_at = EXCLUDED.pushed_at,
         last_scan_at = EXCLUDED.last_scan_at, last_scan_head_sha = EXCLUDED.last_scan_head_sha,
         blocked_scans = EXCLUDED.blocked_scans, newly_blocked_at = EXCLUDED.newly_blocked_at,
         updated_at = now()`,
      [
        repo.name,
        repo.github_full_name ?? `${OWNER}/${repo.name}`,
        repo.pct,
        repo.lane,
        repo.blocker,
        repo.tier,
        repo.hostinger_account ?? null,
        repo.market ?? null,
        repo.next_step ?? null,
        repo.open_prs ?? 0,
        repo.merged_prs_30d ?? repo.merged_prs ?? 0,
        repo.live_url ?? null,
        repo.live_url_ok ?? null,
        // The legacy record wrote `launched` as either a date string or `true`.
        typeof repo.launched === 'string' ? repo.launched : null,
        JSON.stringify(repo.unblocks ?? []),
        JSON.stringify(repo.depends_on ?? []),
        JSON.stringify(repo.related ?? []),
        repo.unblocks_revenue ?? null,
        repo.notes ?? null,
        JSON.stringify(repo.cleared_blockers ?? []),
        repo.snoozed_until ?? null,
        repo.scope_review_due ?? false,
        repo.scope_review_proposed ?? null,
        repo.scope_reviews_unanswered ?? 0,
        repo.kept ?? null,
        typeof repo.killed === 'string' ? repo.killed : null,
        repo.last_commit ?? null,
        repo.pushed_at ?? null,
        repo.last_scan ?? null,
        repo.head_sha ?? null,
        repo.blocked_scans ?? 0,
        repo.newly_blocked ?? null,
      ]
    );
  }
  return repos.length;
}

async function seedStacks(stacksFile: Json): Promise<number> {
  const stacks = stacksFile.stacks as Record<string, Json>;
  let n = 0;
  for (const [name, stack] of Object.entries(stacks)) {
    const repo = await one<{ id: number }>(`SELECT id FROM repos WHERE name = $1`, [name]);
    if (!repo) {
      console.warn(`  ! stack for "${name}" has no repo row — skipped`);
      continue;
    }
    await query(
      `INSERT INTO stacks (repo_id, package_name, engine, dialect, package_manager, migrations,
                           scripts, env_file, env_session, env_deferred_count, notes, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (repo_id) DO UPDATE SET
         package_name = EXCLUDED.package_name, engine = EXCLUDED.engine,
         dialect = EXCLUDED.dialect, package_manager = EXCLUDED.package_manager,
         migrations = EXCLUDED.migrations, scripts = EXCLUDED.scripts,
         env_file = EXCLUDED.env_file, env_session = EXCLUDED.env_session,
         env_deferred_count = EXCLUDED.env_deferred_count, notes = EXCLUDED.notes,
         scanned_at = now()`,
      [
        repo.id,
        stack.package_name ?? null,
        stack.engine ?? null,
        stack.dialect ?? null,
        stack.package_manager ?? null,
        stack.migrations ?? 0,
        JSON.stringify(stack.scripts ?? {}),
        stack.env_file ?? null,
        JSON.stringify(stack.env_session ?? []),
        stack.env_deferred_count ?? 0,
        JSON.stringify(stack.notes ?? []),
      ]
    );
    n++;
  }
  return n;
}

async function seedDecisions(file: Json): Promise<number> {
  const decisions = file.decisions as Json[];
  for (const d of decisions) {
    await query(
      `INSERT INTO decisions (id, question, needed_for, recommended, why, status, answer, batch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         question = EXCLUDED.question, needed_for = EXCLUDED.needed_for,
         recommended = EXCLUDED.recommended, why = EXCLUDED.why`,
      [
        d.id,
        d.question,
        d.needed_for ?? null,
        d.recommended ?? null,
        d.why ?? null,
        d.status ?? 'pending',
        d.answer ?? null,
        d.batch ?? null,
      ]
    );
  }
  return decisions.length;
}

async function seedNudges(file: Json): Promise<number> {
  const history = (file.history as Json[]) ?? [];
  const existing = await one<{ count: string }>(`SELECT count(*)::text AS count FROM nudges`);
  if (Number(existing?.count ?? 0) > 0) {
    console.log(`  nudges: ${existing?.count} rows already present — left alone`);
    return 0;
  }
  for (const h of history) {
    await query(
      `INSERT INTO nudges (repo_names, type, sent_at, outcome, shrunk, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        JSON.stringify(h.repos ?? []),
        h.type,
        h.date ?? new Date().toISOString(),
        h.outcome ?? 'pending',
        h.shrunk ?? false,
        h.note ?? null,
      ]
    );
  }
  return history.length;
}

async function seedSettings(config: Json, portfolio: Json): Promise<void> {
  const meta = (portfolio.meta ?? {}) as Json;
  await query(
    `INSERT INTO settings (id, owner_timezone, hpanel_baseline_minutes, scope_review_last, session_state, updated_at)
     VALUES (TRUE, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       owner_timezone = EXCLUDED.owner_timezone,
       hpanel_baseline_minutes = EXCLUDED.hpanel_baseline_minutes,
       scope_review_last = COALESCE(EXCLUDED.scope_review_last, settings.scope_review_last),
       session_state = EXCLUDED.session_state,
       updated_at = now()`,
    [
      config.owner_timezone ?? 'America/Asuncion',
      config.hpanel_baseline_minutes ?? 0,
      meta.scope_review_last ?? null,
      JSON.stringify(portfolio.session ?? {}),
    ]
  );
}

/** The exit criteria of phase O1, checked by the script that caused them. */
async function report(portfolio: Json, stacksFile: Json) {
  const count = async (table: string) =>
    Number((await one<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`))!.count);

  const repos = await count('repos');
  const stacks = await count('stacks');
  const decisions = await count('decisions');
  const expectedRepos = (portfolio.repos as unknown[]).length;
  const expectedStacks = Object.keys(stacksFile.stacks as object).length;

  const spot = await one<{ name: string; unblocks: string[]; cleared_blockers: unknown[] }>(
    `SELECT name, unblocks, cleared_blockers FROM repos WHERE name = 'propia.node'`
  );

  console.log(`\n  repos      ${repos}/${expectedRepos} ${repos === expectedRepos ? 'ok' : 'MISMATCH'}`);
  console.log(`  stacks     ${stacks}/${expectedStacks} ${stacks === expectedStacks ? 'ok' : 'MISMATCH'}`);
  console.log(`  decisions  ${decisions}`);
  console.log(`  nudges     ${await count('nudges')}`);
  console.log(
    `  spot-check propia.node → unblocks ${JSON.stringify(spot?.unblocks)} ` +
      `${spot?.unblocks?.length ? 'ok' : 'MISSING'}\n`
  );

  if (repos !== expectedRepos || stacks !== expectedStacks || !spot?.unblocks?.length) {
    process.exitCode = 1;
  }
}

async function main() {
  loadEnv();
  const portfolio = read('portfolio.json');
  const stacksFile = read('stacks.json');

  if (process.argv.includes('--check')) {
    await report(portfolio, stacksFile);
    return;
  }

  console.log(`  repos:     ${await seedRepos(portfolio)} migrated`);
  console.log(`  stacks:    ${await seedStacks(stacksFile)} migrated`);
  console.log(`  decisions: ${await seedDecisions(read('decisions.json'))} migrated`);
  console.log(`  nudges:    ${await seedNudges(read('nudges.json'))} migrated`);
  await seedSettings(read('config.json'), portfolio);
  console.log('  settings:  owner timezone + hPanel baseline written');
  await report(portfolio, stacksFile);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
