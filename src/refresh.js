/**
 * refresh.js — the twice-weekly repo scan, applied to the state of record.
 *
 * The scanning itself (GitHub API, shallow clones, reading PLAN/README/docs)
 * happens in the scan session — see SCAN.md. This module is the half that must
 * be right every time, so it is pure and tested: what needs re-scanning, how a
 * scan result changes the portfolio, and what the coach must never do to a
 * human's tick.
 *
 * Two ideas drive it:
 *
 *  1. INCREMENTAL. Re-reading 53 repos on every run is slow and expensive, and
 *     most of them have not moved. `planScan` asks GitHub for `pushed_at` —
 *     one cheap listing — and deep-scans only the repos that changed since the
 *     last scan of that repo.
 *
 *  2. THE HUMAN WINS. A scan is an estimate; a tick is a fact. When they
 *     disagree the scan never silently reverts the tick — it raises a verify
 *     item and lets the owner settle it (DESIGN.md §"drift guard").
 *
 *   node src/refresh.js --plan remote.json         # what would be deep-scanned?
 *   node src/refresh.js --apply results.json       # merge a scan into the state
 *   node src/refresh.js --sweep                    # staleness sweep only
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { load, save, getRepo, isOwnerBlocked, BLOCKERS, LANES, PORTFOLIO_PATH } from './portfolio.js';
import { isoDate } from './select.js';

const DAY = 24 * 60 * 60 * 1000;
const asDate = (iso) => (iso ? Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso) : NaN);

/** A repo untouched for this long earns a scope-review question. */
export const STALE_DAYS = 30;

/** How many consecutive scans a repo may sit owner-blocked before it is called out. */
export const BLOCKED_SCANS_LIMIT = 3;

/* ------------------------------------------------------------------ plan */

/**
 * Decide what to deep-scan. `remote` is the cheap listing: repo name →
 * `{ pushed_at, archived }`. Everything else waits for its next push.
 *
 * A repo is deep-scanned when it has never been scanned, when it has been
 * pushed to since its last scan, or when its recorded state is old enough that
 * a re-read is worth it anyway (`maxAgeDays`) — that last one catches repos
 * whose progress happened outside git, and repos the audit guessed at.
 */
export function planScan(portfolio, remote = {}, { now = Date.now(), force = [], maxAgeDays = 30 } = {}) {
  // The 2026-08 audit is valid seed data: the first real scan is an incremental
  // update against it, not a cold re-read of 53 repos.
  const baseline = portfolio.meta?.baseline_scan ?? null;
  const deep = [];
  const skipped = [];
  const unknown = [];

  for (const repo of portfolio.repos) {
    const info = remote[repo.name];
    if (!info) {
      unknown.push(repo.name);
      continue;
    }
    if (info.archived) {
      skipped.push({ name: repo.name, why: 'archived on GitHub' });
      continue;
    }
    if (force.includes(repo.name)) {
      deep.push({ name: repo.name, why: 'forced' });
      continue;
    }
    const since = repo.last_scan ?? baseline;
    if (!since) {
      deep.push({ name: repo.name, why: 'never scanned' });
      continue;
    }
    if (info.pushed_at && asDate(info.pushed_at) > asDate(since)) {
      deep.push({ name: repo.name, why: `pushed ${info.pushed_at.slice(0, 10)}` });
      continue;
    }
    // `git ls-remote` fallback: a changed head SHA means the same thing as a
    // newer pushed_at, and needs no API call at all. Useful when the scan
    // session has git access but not GitHub API access.
    if (info.head && repo.head_sha && info.head !== repo.head_sha) {
      deep.push({ name: repo.name, why: `head moved to ${info.head.slice(0, 7)}` });
      continue;
    }
    if (info.head && !repo.head_sha) {
      deep.push({ name: repo.name, why: 'no head recorded yet' });
      continue;
    }
    if ((now - asDate(since)) / DAY >= maxAgeDays) {
      deep.push({ name: repo.name, why: `record is ${Math.round((now - asDate(since)) / DAY)} days old` });
      continue;
    }
    skipped.push({ name: repo.name, why: repo.last_scan ? 'no new commits' : 'unchanged since the audit' });
  }

  return { deep, skipped, unknown };
}

/* ----------------------------------------------------------------- apply */

const isCleared = (repo) => Array.isArray(repo.cleared_blockers) && repo.cleared_blockers.length > 0;

/**
 * Merge one scan into the portfolio.
 *
 * `results` is repo name → whatever the scan session found:
 *   { pct, last_commit, blocker, lane, next_step, open_prs, merged_prs, live_url_ok }
 * Every field is optional; absent means "the scan learned nothing new".
 *
 * Returns the change list, the drift items a human must settle, and the
 * launches detected.
 */
export function applyScan(portfolio, results = {}, { date = isoDate(Date.now()) } = {}) {
  const changes = [];
  const drift = [];
  const launches = [];

  for (const [name, result] of Object.entries(results)) {
    let repo;
    try {
      repo = getRepo(portfolio, name);
    } catch {
      changes.push(`${name}: seen by the scan but not in the portfolio — ignored`);
      continue;
    }

    repo.last_scan = date;
    if (result.pushed_at) repo.pushed_at = result.pushed_at;
    if (result.head) repo.head_sha = result.head;
    if (result.last_commit) repo.last_commit = result.last_commit;
    if (typeof result.open_prs === 'number') repo.open_prs = result.open_prs;
    if (typeof result.merged_prs === 'number') repo.merged_prs = result.merged_prs;
    if (result.next_step) repo.next_step = result.next_step;

    // --- completion: moves freely upward, and downward only with a note. A
    // percentage that falls is usually the scan being pessimistic, not work
    // being undone.
    if (typeof result.pct === 'number' && result.pct !== repo.pct) {
      if (result.pct >= repo.pct) {
        changes.push(`${name}: ${repo.pct}% → ${result.pct}%`);
        repo.pct = result.pct;
      } else {
        drift.push({
          repo: name,
          note: `the scan reads ${name} as ${result.pct}% done, the record says ${repo.pct}%. Which is right?`,
        });
      }
    }

    // --- launch detection: a live URL that answers, or the scan saying so.
    if ((result.live_url_ok === true || result.launched === true) && !repo.launched) {
      repo.launched = date;
      repo.pct = 100;
      repo.blocker = 'none';
      repo.lane = 'launch-agent-drivable';
      launches.push(name);
      changes.push(`${name}: detected live`);
      continue;
    }

    // --- blockers. THE DRIFT GUARD: a repo the owner ticked clear is never
    // silently re-blocked. The scan may be reading a stale deploy, and
    // un-ticking someone's finished work is the fastest way to lose their
    // trust in the whole system.
    if (result.blocker && BLOCKERS.includes(result.blocker) && result.blocker !== repo.blocker) {
      if (result.blocker !== 'none' && isCleared(repo) && repo.blocker === 'none') {
        drift.push({
          repo: name,
          note: `you marked ${name} unblocked, but the scan still sees "${result.blocker}". Did it actually go through?`,
        });
      } else {
        const was = repo.blocker;
        repo.blocker = result.blocker;
        if (result.lane && LANES.includes(result.lane)) repo.lane = result.lane;
        changes.push(`${name}: blocker ${was} → ${result.blocker}`);
        // Crossing INTO owner-blocked is the signal worth surfacing: it is new
        // work landing on the owner's plate without them asking for it.
        if (!isOwnerBlocked({ blocker: was }) && isOwnerBlocked(repo)) {
          repo.newly_blocked = date;
          changes.push(`${name}: newly blocked on you`);
        }
        if (!isOwnerBlocked(repo)) delete repo.newly_blocked;
      }
    } else if (result.lane && LANES.includes(result.lane) && result.lane !== repo.lane) {
      changes.push(`${name}: lane ${repo.lane} → ${result.lane}`);
      repo.lane = result.lane;
    }

    // --- how long has this been sitting on the owner?
    if (isOwnerBlocked(repo)) {
      repo.blocked_scans = (repo.blocked_scans ?? 0) + 1;
      if (repo.blocked_scans === BLOCKED_SCANS_LIMIT) {
        changes.push(`${name}: owner-blocked for ${BLOCKED_SCANS_LIMIT} scans running`);
      }
    } else {
      delete repo.blocked_scans;
    }
  }

  // Drift items live on the repo so the dashboard can render them and a tick
  // can settle them.
  for (const item of drift) {
    const repo = getRepo(portfolio, item.repo);
    if (repo.drift_note !== item.note) {
      repo.drift_note = item.note;
      repo.drift_date = date;
    }
  }

  return { changes, drift, launches };
}

/* ----------------------------------------------------------------- sweep */

/**
 * Flag repos nobody has touched in a month for the scope review. Nearly
 * finished work is exempt: "untouched" is a question about whether a project
 * should exist, and a 95% repo has already answered it.
 */
export function stalenessSweep(portfolio, { now = Date.now(), days = STALE_DAYS, maxPct = 70 } = {}) {
  const flagged = [];
  for (const repo of portfolio.repos) {
    if (repo.pct >= maxPct || repo.launched) continue;
    if (repo.scope_review_due || repo.scope_review) continue;
    const last = repo.last_commit ?? repo.pushed_at;
    if (!last) continue;
    if ((now - asDate(last)) / DAY < days) continue;
    repo.scope_review_due = true;
    flagged.push(repo.name);
  }
  return flagged;
}

/**
 * Repos the coach has now asked about twice with no answer get proposed as a
 * snooze rather than asked a third time (DESIGN.md §2.5).
 */
export function autoProposeSnooze(portfolio, { reviews = 2 } = {}) {
  const proposed = [];
  for (const repo of portfolio.repos) {
    if (!repo.scope_review_due || repo.scope_review) continue;
    repo.scope_reviews_unanswered = (repo.scope_reviews_unanswered ?? 0) + 1;
    if (repo.scope_reviews_unanswered >= reviews && !repo.scope_review_proposed) {
      repo.scope_review_proposed = 'snooze';
      proposed.push(repo.name);
    }
  }
  return proposed;
}

/* -------------------------------------------------------------------- CLI */

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const portfolio = load();
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

  if (argv.includes('--plan')) {
    const file = arg('--plan');
    const remote = file && existsSync(file) ? readJson(file) : {};
    const { deep, skipped, unknown } = planScan(portfolio, remote);
    console.log(`\ndeep-scan ${deep.length}, skip ${skipped.length}, unknown to GitHub ${unknown.length}\n`);
    for (const d of deep) console.log(`  scan  ${d.name.padEnd(24)} ${d.why}`);
    if (unknown.length) console.log(`\n  not in the listing: ${unknown.join(', ')}`);
    console.log();
    return;
  }

  if (argv.includes('--apply')) {
    const results = readJson(arg('--apply'));
    const date = arg('--date') ?? isoDate(Date.now());
    const { changes, drift, launches } = applyScan(portfolio, results, { date });
    const flagged = stalenessSweep(portfolio);
    if (flagged.length) changes.push(`scope review due: ${flagged.join(', ')}`);
    save(portfolio);
    console.log(JSON.stringify({ date, changes, drift, launches, scope_review_due: flagged }, null, 2));
    return;
  }

  if (argv.includes('--sweep')) {
    const flagged = stalenessSweep(portfolio);
    const proposed = autoProposeSnooze(portfolio);
    save(portfolio);
    console.log(JSON.stringify({ scope_review_due: flagged, snooze_proposed: proposed }, null, 2));
    return;
  }

  console.log(`usage:
  node src/refresh.js --plan <remote.json>    which repos need a deep scan
  node src/refresh.js --apply <results.json>  merge a scan into ${PORTFOLIO_PATH.split('/').slice(-2).join('/')}
  node src/refresh.js --sweep                 staleness + snooze proposals only`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
