/**
 * score.ts — leverage scoring, queue ordering, DB batch composition.
 *
 * A faithful port of scripts/legacy/src/score.js (DESIGN.md §4):
 *
 *   score = completion + unblock + tier − effort − staleness
 *
 * Same coefficients, same invariant, same batching rules — the only change is
 * that it operates on `repos` rows from Neon instead of data/portfolio.json.
 * Pure functions: the database round-trip lives in lib/queries.ts.
 */

import {
  type Repo,
  isDormant,
  isOwnerBlocked,
  isoDate,
  ownerMinutes,
  unblockedBy,
} from './domain';

export interface Coefficients {
  completionLinear: number;
  completionSteep: number;
  steepFrom: number;
  unblockPerSibling: number;
  unblockCap: number;
  unblockRevenue: number;
  tier: Record<string, number>;
  effortPerMinute: number;
  stalenessMaxPct: number;
  stalenessPerMonth: number;
  stalenessCap: number;
}

export const DEFAULT_COEFFICIENTS: Coefficients = {
  // completion_weight: linear in %, plus a steep bonus above `steepFrom` so
  // "almost done" dominates everything else in the formula.
  completionLinear: 0.5,
  completionSteep: 6.0,
  steepFrom: 85,

  // unblock_weight: sibling repos freed by this launch, plus a bonus when the
  // repo is what actually collects money.
  unblockPerSibling: 10,
  unblockCap: 2,
  unblockRevenue: 12,

  // tier_weight: infra > revenue-test > speculative (DESIGN §4, Decision D3).
  tier: { infra: 20, revenue: 10, experiment: 0 },

  // effort_penalty: per estimated owner-minute of the blocker.
  effortPerMinute: 0.3,

  // staleness_decay: mild, early-stage repos only — it feeds the scope review,
  // it must never demote a nearly-finished repo.
  stalenessMaxPct: 40,
  stalenessPerMonth: 3,
  stalenessCap: 10,
};

/**
 * Repos whose launch unblocks revenue *collection* (DESIGN §4). A row can
 * override this with `unblocks_revenue`.
 */
export const REVENUE_COLLECTION = new Set(['facturar', 'vendercrm', 'contabilidad']);

/**
 * The invariant the whole coach rests on: a nearly-finished repo outranks a
 * barely-started one no matter how well-connected the latter is. Tier cancels
 * out (infra is the top tier), which leaves the real condition:
 *
 *   completion advantage of 95%, minus the worst effort penalty,
 *   must exceed the largest unblock bonus a 0% repo can collect.
 */
export function validateCoefficients(
  coef: Coefficients = DEFAULT_COEFFICIENTS,
  { maxMinutes = 30 }: { maxMinutes?: number } = {}
): Coefficients {
  const tiers = Object.values(coef.tier);
  if (coef.tier.infra !== Math.max(...tiers)) {
    throw new Error('coefficients violate DESIGN §4: infra must be the highest tier weight');
  }
  const bestZeroBonus = coef.unblockPerSibling * coef.unblockCap + coef.unblockRevenue;
  const worstNinetyFive =
    coef.completionLinear * 95 +
    coef.completionSteep * Math.max(0, 95 - coef.steepFrom) -
    coef.effortPerMinute * maxMinutes;
  if (!(worstNinetyFive > bestZeroBonus)) {
    throw new Error(
      `coefficients violate the completion-dominance invariant: ` +
        `worst 95% repo earns ${worstNinetyFive.toFixed(2)}, best 0% repo bonus is ${bestZeroBonus.toFixed(2)}`
    );
  }
  return coef;
}

export interface ScoreParts {
  total: number;
  completion: number;
  unblock: number;
  tier: number;
  effort: number;
  staleness: number;
  unblocks: string[];
  minutes: number;
}

export interface ScoredRepo extends ScoreParts {
  repo: Repo;
}

export interface ScoreOptions {
  coef?: Coefficients;
  now?: number;
  date?: string;
}

function monthsSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const then = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now - then) / (1000 * 60 * 60 * 24 * 30.4375));
}

/** Score one repo. Returns the total plus its components, for explainability. */
export function scoreRepo(repo: Repo, all: Repo[], { coef = DEFAULT_COEFFICIENTS, now = Date.now() }: ScoreOptions = {}): ScoreParts {
  const completion =
    coef.completionLinear * repo.pct + coef.completionSteep * Math.max(0, repo.pct - coef.steepFrom);

  const known = all.some((r) => r.name === repo.name);
  const siblings = known ? unblockedBy(all, repo.name) : [...new Set(repo.unblocks ?? [])];
  const revenue = repo.unblocks_revenue ?? REVENUE_COLLECTION.has(repo.name);
  const unblock =
    coef.unblockPerSibling * Math.min(siblings.length, coef.unblockCap) + (revenue ? coef.unblockRevenue : 0);

  const tier = coef.tier[repo.tier] ?? 0;
  const effort = coef.effortPerMinute * ownerMinutes(repo);

  const staleness =
    repo.pct < coef.stalenessMaxPct
      ? Math.min(coef.stalenessCap, monthsSince(repo.last_commit_at, now) * coef.stalenessPerMonth)
      : 0;

  return {
    total: completion + unblock + tier - effort - staleness,
    completion,
    unblock,
    tier,
    effort,
    staleness,
    unblocks: siblings,
    minutes: ownerMinutes(repo),
  };
}

/**
 * Every repo, scored, highest first. Ties break by % then name, for stability.
 * Killed and snoozed repos are out — the owner said not to show them.
 */
export function rank(repos: Repo[], { date, ...opts }: ScoreOptions = {}): ScoredRepo[] {
  const today = date ?? isoDate(opts.now ?? Date.now());
  return repos
    .filter((repo) => !isDormant(repo, today))
    .map((repo) => ({ repo, ...scoreRepo(repo, repos, opts) }))
    .sort(
      (a, b) => b.total - a.total || b.repo.pct - a.repo.pct || a.repo.name.localeCompare(b.repo.name)
    );
}

/** The launch queue (DESIGN.md §2.2): owner-blocked repos at or above `minPct`. */
export function launchQueue(repos: Repo[], { minPct = 70, ...opts }: ScoreOptions & { minPct?: number } = {}): ScoredRepo[] {
  return rank(repos, opts).filter((e) => isOwnerBlocked(e.repo) && e.repo.pct >= minPct);
}

/** The read-only agent lane (DESIGN.md §2.4): repos an agent can move alone. */
export function agentLane(repos: Repo[], opts: ScoreOptions = {}): ScoredRepo[] {
  return rank(repos, opts).filter((e) => !isOwnerBlocked(e.repo) && e.repo.blocker !== 'sibling');
}

/* ------------------------------------------------------------------ batching */

/**
 * Swedish-market repos, used only as the *proxy* grouping key until Decision D2
 * says which Hostinger account hosts what. A row can state the truth directly
 * with `hostinger_account` (which always wins) or `market`.
 */
export const SE_REPOS = new Set([
  'besikt',
  'byggmedia',
  'brfinspektion',
  'entreprenadjobb',
  'hantverkarsystemet',
  'studievagledare',
  'aireceptionisterna',
]);

export function marketOf(repo: Pick<Repo, 'name' | 'market'>): 'se' | 'py' {
  return repo.market ?? (SE_REPOS.has(repo.name) ? 'se' : 'py');
}

/** The grouping key for one hPanel sitting. */
export function batchKey(repo: Pick<Repo, 'name' | 'market' | 'hostinger_account'>): string {
  if (repo.hostinger_account) return `account:${repo.hostinger_account}`;
  return `market:${marketOf(repo)}`;
}

/**
 * Minutes for a sitting of `n` DBs: a fixed panel-relearning cost amortized
 * across the batch, plus per-repo work. Three repos ≈ 45 min (DESIGN.md §1a);
 * one repo alone ≈ 25.
 */
export function batchMinutes(n: number): number {
  return 15 + 10 * n;
}

export interface DbBatch {
  key: string;
  repos: string[];
  entries: ScoredRepo[];
  minutes: number;
  score: number;
  topScore: number;
}

/**
 * Compose DB sessions: group `db-setup` repos by Hostinger account (or the D2
 * market proxy), then chunk each group into sittings of at most `size`, in
 * leverage order. Batches come back best-first by their top repo's score.
 */
export function dbBatches(repos: Repo[], { size = 3, ...opts }: ScoreOptions & { size?: number } = {}): DbBatch[] {
  const scored = new Map(rank(repos, opts).map((e) => [e.repo.name, e]));
  const groups = new Map<string, ScoredRepo[]>();

  for (const repo of repos.filter((r) => r.blocker === 'db-setup')) {
    const entry = scored.get(repo.name);
    if (!entry) continue; // dormant
    const key = batchKey(repo);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  const batches: DbBatch[] = [];
  for (const [key, entries] of groups) {
    entries.sort((a, b) => b.total - a.total);
    for (let i = 0; i < entries.length; i += size) {
      const members = entries.slice(i, i + size);
      batches.push({
        key,
        repos: members.map((e) => e.repo.name),
        entries: members,
        minutes: batchMinutes(members.length),
        score: members.reduce((sum, e) => sum + e.total, 0),
        topScore: members[0].total,
      });
    }
  }
  return batches.sort((a, b) => b.topScore - a.topScore);
}
