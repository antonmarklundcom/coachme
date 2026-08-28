/**
 * scan/run.ts — one scan invocation.
 *
 * Cheap listing → `planScan` → deep-read at most `cap` repos → drift guard →
 * write. Two constraints shape it:
 *
 *  - It must fit a serverless timeout, so deep scans are capped per invocation
 *    (worst case is one Sonnet call each).
 *  - It must be resumable, so nothing is "the rest of this run": `last_scan_at`
 *    and `last_scan_head_sha` already encode progress, and a repo is only
 *    stamped once it has actually been read. A firing that finds more work than
 *    its cap does the first N; the next firing (or a manual re-trigger)
 *    continues where it stopped.
 */

import { isoDate, type Repo } from '../domain';
import {
  getRepos,
  getSettings,
  recordScanEvent,
  updateRepo,
  upsertStack,
} from '../queries';
import { autoProposeSnooze, decideScanUpdate, stalenessSweep, type ScanFinding } from './apply';
import { ClassifierUnavailable, classifyRepo } from './classify';
import { checkLiveUrl, fetchDocs, getRepoInfo, listCommits, listOwnerRepos, listPulls } from './github';
import { planScan, type RemoteListing } from './plan';
import { fetchStack } from './stacks';

export const OWNER = 'antonmarklundcom';
/** Deep scans per invocation. The rest wait for the next firing (resumable). */
export const DEFAULT_CAP = 5;
/** The 2026-08 audit is every repo's baseline scan until a real one lands. */
export const BASELINE_SCAN = '2026-08-01';

export interface ScanRunOptions {
  source: 'cron' | 'manual';
  cap?: number;
  force?: string[];
  now?: number;
}

export interface ScanRunResult {
  planned: number;
  scanned: string[];
  deferred: string[];
  changes: string[];
  verify: { repo: string; reason: string }[];
  launches: string[];
  scope_review_due: string[];
  snooze_proposed: string[];
  degraded: string[];
  events: number;
}

function fullNameOf(repo: Repo): string {
  return repo.github_full_name ?? `${OWNER}/${repo.name}`;
}

/** Everything one repo's deep read can find, from evidence and from judgement. */
async function deepScan(repo: Repo, degraded: string[]): Promise<ScanFinding> {
  const fullName = fullNameOf(repo);
  const finding: ScanFinding = {};

  const [docs, commits, pulls] = await Promise.all([
    fetchDocs(fullName).catch(() => []),
    listCommits(fullName).catch(() => []),
    listPulls(fullName).catch(() => ({ open: [], mergedLast30d: [] })),
  ]);

  // Evidence first — these never depend on a model being reachable.
  if (commits[0]) {
    finding.last_commit = commits[0].date.slice(0, 10);
    finding.head = commits[0].sha;
  }
  finding.open_prs = pulls.open.length;
  finding.merged_prs_30d = pulls.mergedLast30d.length;

  // The launch signal: a URL that answers. Fetched, never inferred.
  if (repo.live_url) {
    finding.live_url_ok = await checkLiveUrl(repo.live_url);
  }

  try {
    const judged = await classifyRepo({
      name: repo.name,
      recordedPct: repo.pct,
      recordedBlocker: repo.blocker,
      docs,
      commits,
      openPrs: pulls.open,
      mergedPrs: pulls.mergedLast30d,
    });
    // Evidence wins over judgement wherever both exist.
    Object.assign(finding, judged, {
      last_commit: finding.last_commit ?? judged.last_commit,
      open_prs: finding.open_prs,
      merged_prs_30d: finding.merged_prs_30d,
      head: finding.head,
      live_url_ok: finding.live_url_ok,
    });
  } catch (err) {
    if (err instanceof ClassifierUnavailable) {
      degraded.push(
        'ANTHROPIC_API_KEY is not set — scanned for commits, PRs, live URL and stack metadata only, no classification.'
      );
    } else {
      degraded.push(`${repo.name}: classification failed (${(err as Error).message})`);
    }
  }

  return finding;
}

/**
 * The per-repo fallback for the cheap listing: ask each known repo for its own
 * `pushed_at`. Six at a time, so a scan of 53 repos is a handful of round-trips
 * rather than 53 sequential ones.
 */
async function probeEachRepo(repos: Repo[], degraded: string[]): Promise<RemoteListing> {
  const remote: RemoteListing = {};
  const queue = [...repos];
  const workers = Array.from({ length: 6 }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      try {
        const info = await getRepoInfo(fullNameOf(repo));
        if (info) remote[repo.name] = { pushed_at: info.pushed_at, archived: info.archived };
      } catch {
        // A repo GitHub will not talk about is simply not planned this run;
        // planScan reports it as unknown rather than guessing.
      }
    }
  });
  await Promise.all(workers);
  if (Object.keys(remote).length === 0) degraded.push('No repo could be reached on the GitHub API.');
  return remote;
}

export async function runScan(opts: ScanRunOptions): Promise<ScanRunResult> {
  const { source, cap = DEFAULT_CAP, force = [], now = Date.now() } = opts;
  const date = isoDate(now);
  const degraded: string[] = [];

  const repos = await getRepos();
  const settings = await getSettings();

  // 1. the cheap listing.
  let remote: RemoteListing = {};
  try {
    const listed = await listOwnerRepos(OWNER);
    remote = Object.fromEntries(
      listed.map((r) => [r.name, { pushed_at: r.pushed_at, archived: r.archived }])
    );
  } catch (err) {
    degraded.push(`GitHub owner listing unavailable (${(err as Error).message}) — probing repos individually.`);
  }
  // An owner listing that answered but knows none of our repos is as useless as
  // one that failed; either way, fall back to asking each repo about itself.
  if (repos.length > 0 && repos.every((r) => !remote[r.name])) {
    remote = { ...remote, ...(await probeEachRepo(repos, degraded)) };
  }

  // 2. what is worth reading.
  const plan = planScan(repos, remote, { now, force, baselineScan: BASELINE_SCAN });
  const todo = plan.deep.slice(0, cap);
  const deferred = plan.deep.slice(cap).map((d) => d.name);

  const result: ScanRunResult = {
    planned: plan.deep.length,
    scanned: [],
    deferred,
    changes: [],
    verify: [],
    launches: [],
    scope_review_due: [],
    snooze_proposed: [],
    degraded,
    events: 0,
  };

  // 3–5. read, record, then apply.
  for (const item of todo) {
    const repo = repos.find((r) => r.name === item.name)!;
    let finding: ScanFinding;
    try {
      finding = await deepScan(repo, degraded);
    } catch (err) {
      degraded.push(`${repo.name}: deep scan failed (${(err as Error).message})`);
      continue;
    }

    const decision = decideScanUpdate(repo, finding, { date, now });

    // The event is written first: `repos` is never changed by a scan that left
    // no audit trail.
    await recordScanEvent({
      repo_id: repo.id,
      source,
      findings: { why: item.why, ...finding },
      applied: decision.verifyReason === null,
      verify_reason: decision.verifyReason,
    });
    result.events++;

    await updateRepo(repo.id, decision.patch);
    result.scanned.push(repo.name);
    result.changes.push(...decision.changes);
    if (decision.verifyReason) result.verify.push({ repo: repo.name, reason: decision.verifyReason });
    if (decision.launched) result.launches.push(repo.name);

    // Stack metadata for DB-blocked repos — the old clone-based
    // `runbook.js --scan`, done over the API so runbooks stay current.
    const blockerAfter = (decision.patch.blocker as string) ?? repo.blocker;
    if (blockerAfter === 'db-setup') {
      try {
        const stack = await fetchStack(fullNameOf(repo));
        if (stack) await upsertStack(repo.id, stack);
      } catch (err) {
        degraded.push(`${repo.name}: stack refresh failed (${(err as Error).message})`);
      }
    }
  }

  // 6. the staleness sweep, and the twice-ignored snooze proposal.
  const after = await getRepos();
  const flagged = stalenessSweep(after, { now, date, scopeReviewLast: settings.scope_review_last });
  for (const name of flagged) {
    const repo = after.find((r) => r.name === name)!;
    await updateRepo(repo.id, { scope_review_due: true });
  }
  result.scope_review_due = flagged;

  for (const proposal of autoProposeSnooze(await getRepos())) {
    const repo = after.find((r) => r.name === proposal.name);
    if (!repo) continue;
    await updateRepo(repo.id, {
      scope_reviews_unanswered: proposal.unanswered,
      ...(proposal.propose ? { scope_review_proposed: 'snooze' } : {}),
    });
    if (proposal.propose) result.snooze_proposed.push(proposal.name);
  }

  return result;
}
