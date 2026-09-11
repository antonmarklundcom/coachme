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

import { branchFor, isoDate, type Repo, type WorkItem } from '../domain';
import {
  getRepoById,
  getRepos,
  getSettings,
  getWorkItems,
  recordScanEvent,
  setStage,
  setWorkItemStatus,
  updateRepo,
  upsertStack,
} from '../queries';
import { prState } from '../github/checks';
import { statusFromGithub } from '../launch/items';
import { proposeStage } from '../launch/stage';
import { GeneratorUnavailable, generateForRepo } from '../generate/run';
import { autoProposeSnooze, decideScanUpdate, stalenessSweep, type ScanFinding } from './apply';
import { ClassifierUnavailable, classifyRepo } from './classify';
import {
  branchExists,
  checkLiveUrl,
  fetchDocs,
  getChecks,
  getRepoInfo,
  listClosedPullDetails,
  listCommits,
  listOpenPullDetails,
  listOwnerRepos,
  listPulls,
} from './github';
import { linkPulls } from './link';
import { refreshWriteAccess } from '../github/probe';
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
  /** v3 (Decision D-G): work items whose GitHub state moved this run. */
  tracked: { repo: string; slug: string; status: string; pr_state: string | null }[];
  /** Stages raised from evidence this run (plan.md §2). */
  staged: { repo: string; stage: string; evidence: string }[];
  /** New proposals from the generator, per repo. */
  proposed: { repo: string; slugs: string[] }[];
}

/** Statuses whose GitHub side is still moving, so worth a look each scan. */
const TRACKABLE = ['dispatched', 'in_progress', 'pr_open'];

/**
 * Find the pull requests our dispatched work turned into, and advance each item
 * (Decision D-G). Only runs for repos that actually have work in flight, so a
 * scan of 61 repos costs nothing extra on the 58 that do not.
 */
async function trackWork(
  repo: Repo,
  fullName: string,
  degraded: string[]
): Promise<ScanRunResult['tracked']> {
  const items = (await getWorkItems(repo.id)).filter((i) => TRACKABLE.includes(i.status));
  if (items.length === 0) return [];

  const moved: ScanRunResult['tracked'] = [];
  let pulls;
  try {
    pulls = [...(await listOpenPullDetails(fullName)), ...(await listClosedPullDetails(fullName))];
  } catch (err) {
    degraded.push(`${repo.name}: pull requests unreadable (${(err as Error).message})`);
    return [];
  }

  const linked = linkPulls(items, pulls);
  const linkedIds = new Set(linked.map((l) => l.item.id));

  for (const { item, pull } of linked) {
    let state: ReturnType<typeof prState>;
    try {
      state = prState(pull, await getChecks(fullName, pull.head.sha));
    } catch (err) {
      degraded.push(`${repo.name}: checks unreadable for #${pull.number} (${(err as Error).message})`);
      state = pull.merged ? 'merged' : 'open';
    }
    const next = statusFromGithub(item.status, { branch: true, pr: true, merged: pull.merged });
    const updated = await setWorkItemStatus(item.id, next, {
      pr_url: pull.html_url,
      pr_number: pull.number,
      pr_state: state,
      branch: pull.head.ref,
    });
    moved.push({ repo: repo.name, slug: updated.slug, status: updated.status, pr_state: state });
  }

  // No PR yet: a branch that exists is the agent having started.
  for (const item of items) {
    if (linkedIds.has(item.id) || item.status !== 'dispatched' || item.kind !== 'agent') continue;
    const branch = item.branch ?? branchFor(item.slug);
    if (await branchExists(fullName, branch).catch(() => false)) {
      const updated = await setWorkItemStatus(item.id, 'in_progress', { branch });
      moved.push({ repo: repo.name, slug: updated.slug, status: updated.status, pr_state: null });
    }
  }

  return moved;
}

/**
 * Raise the stage if — and only if — this run fetched something that proves it
 * (plan.md §2). Reads the row back first so it judges what the scan just wrote,
 * not what it read at the start.
 */
async function raiseStage(
  repoId: number,
  date: string,
  degraded: string[]
): Promise<ScanRunResult['staged']> {
  const repo = await getRepoById(repoId);
  if (!repo) return [];

  // `sellable` needs a page that answers, and the only way to know is to fetch
  // it — the same rule the live URL has followed since v2.
  let sellUrlOk: boolean | undefined;
  if (repo.sell_url) {
    sellUrlOk = await checkLiveUrl(repo.sell_url).catch(() => false);
  }

  const claim = proposeStage(repo, { sell_url_ok: sellUrlOk });
  if (!claim) return [];

  try {
    await setStage(repo, claim, 'scan', { date });
  } catch (err) {
    degraded.push(`${repo.name}: stage not raised (${(err as Error).message})`);
    return [];
  }
  return [{ repo: repo.name, stage: claim.stage, evidence: claim.evidence }];
}

/** Propose work for a repo the scan has just refreshed. */
async function propose(
  repoId: number,
  repoName: string,
  degraded: string[],
  noKey: { reported: boolean }
): Promise<ScanRunResult['proposed']> {
  try {
    const result = await generateForRepo(repoId);
    degraded.push(...result.degraded);
    return result.created.length ? [{ repo: repoName, slugs: result.created.map((i: WorkItem) => i.slug) }] : [];
  } catch (err) {
    if (err instanceof GeneratorUnavailable) {
      if (!noKey.reported) {
        degraded.push('ANTHROPIC_API_KEY is not set — no work items were proposed this run.');
        noKey.reported = true;
      }
    } else {
      degraded.push(`${repoName}: generation failed (${(err as Error).message})`);
    }
    return [];
  }
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
    tracked: [],
    staged: [],
    proposed: [],
  };
  const noKey = { reported: false };

  // 3–5. read, record, then apply.
  for (const item of todo) {
    const repo = repos.find((r) => r.name === item.name)!;
    const fullName = fullNameOf(repo);
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

    // v3: what the dispatched work turned into, what the evidence now supports,
    // and what to propose next. Each is independent — one failing must not cost
    // the others, so each reports into `degraded` and returns empty.
    result.tracked.push(...(await trackWork(repo, fullName, degraded)));
    result.staged.push(...(await raiseStage(repo.id, date, degraded)));
    result.proposed.push(...(await propose(repo.id, repo.name, degraded, noKey)));

    // Stack metadata for DB-blocked repos — the old clone-based
    // `runbook.js --scan`, done over the API so runbooks stay current.
    const blockerAfter = (decision.patch.blocker as string) ?? repo.blocker;
    if (blockerAfter === 'db-setup') {
      try {
        const stack = await fetchStack(fullName);
        if (stack) await upsertStack(repo.id, stack);
      } catch (err) {
        degraded.push(`${repo.name}: stack refresh failed (${(err as Error).message})`);
      }
    }
  }

  // 5b. one cheap probe per run, so the work desk knows whether to offer the
  // repo-file dispatch or only the copy one (Decision D-F). Never fatal.
  try {
    const probe = await refreshWriteAccess();
    if (!probe.ok) degraded.push(`GitHub write access unavailable: ${probe.reason}`);
  } catch (err) {
    degraded.push(`write-access probe failed (${(err as Error).message})`);
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
