/**
 * score.js — leverage scoring, queue ordering, DB batch composition.
 *
 * Implements DESIGN.md §4:
 *   score = completion + unblock + tier − effort − staleness
 *
 * Run it directly to print the ranked launch queue and the first proposed DB
 * batch from the seeded data:
 *
 *   node src/score.js            # ranked queue + first batch
 *   node src/score.js --batches  # every proposed batch
 *   node src/score.js --json     # machine-readable
 */

import {
  load,
  isOwnerBlocked,
  ownerMinutes,
  unblockedBy,
  dbBlockedRepos,
} from './portfolio.js';

/**
 * Default coefficients. Tuning these is expected; breaking the domination
 * invariant below is not (see validateCoefficients / the unit tests).
 */
export const DEFAULT_COEFFICIENTS = {
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
 * Repos whose launch unblocks revenue *collection* (DESIGN §4). A repo can
 * override this with `"unblocks_revenue": true` in portfolio.json.
 */
export const REVENUE_COLLECTION = new Set(['facturar', 'vendercrm', 'contabilidad']);

/**
 * The invariant the whole coach rests on: a nearly-finished repo outranks a
 * barely-started one no matter how well-connected the latter is. Tier cancels
 * out (infra is the top tier, so a 95% infra repo always carries at least as
 * much tier weight as any 0% repo), which leaves the real condition:
 *
 *   completion advantage of 95%, minus the worst effort penalty,
 *   must exceed the largest unblock bonus a 0% repo can collect.
 */
export function validateCoefficients(coef = DEFAULT_COEFFICIENTS, { maxMinutes = 30 } = {}) {
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

/**
 * Repos freed by launching this one. Works on detached repo objects too (the
 * dashboard scores hypotheticals), falling back to the declared edges only.
 */
function siblingsOf(repo, portfolio) {
  const known = portfolio?.repos?.some((r) => r.name === repo.name);
  return known ? unblockedBy(portfolio, repo.name) : [...new Set(repo.unblocks ?? [])];
}

function monthsSince(iso, now) {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now - then) / (1000 * 60 * 60 * 24 * 30.4375));
}

/** Score one repo. Returns the total plus its components, for explainability. */
export function scoreRepo(repo, portfolio, { coef = DEFAULT_COEFFICIENTS, now = Date.now() } = {}) {
  const completion =
    coef.completionLinear * repo.pct +
    coef.completionSteep * Math.max(0, repo.pct - coef.steepFrom);

  const siblings = siblingsOf(repo, portfolio);
  const revenue = repo.unblocks_revenue ?? REVENUE_COLLECTION.has(repo.name);
  const unblock =
    coef.unblockPerSibling * Math.min(siblings.length, coef.unblockCap) +
    (revenue ? coef.unblockRevenue : 0);

  const tier = coef.tier[repo.tier] ?? 0;
  const effort = coef.effortPerMinute * ownerMinutes(repo);

  const staleness =
    repo.pct < coef.stalenessMaxPct
      ? Math.min(coef.stalenessCap, monthsSince(repo.last_commit, now) * coef.stalenessPerMonth)
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

/** Every repo, scored, highest first. Ties break by % then name, for stability. */
export function rank(portfolio, opts = {}) {
  return portfolio.repos
    .map((repo) => ({ repo, ...scoreRepo(repo, portfolio, opts) }))
    .sort((a, b) => b.total - a.total || b.repo.pct - a.repo.pct || a.repo.name.localeCompare(b.repo.name));
}

/**
 * The launch queue shown on the dashboard (DESIGN.md §2.2): owner-blocked repos
 * at or above `minPct`, ranked by leverage.
 */
export function launchQueue(portfolio, { minPct = 70, ...opts } = {}) {
  return rank(portfolio, opts).filter((e) => isOwnerBlocked(e.repo) && e.repo.pct >= minPct);
}

/**
 * Repos whose blocker an agent can clear without the owner — the read-only
 * "agent lane" panel (DESIGN.md §2.4).
 */
export function agentLane(portfolio, opts = {}) {
  return rank(portfolio, opts).filter((e) => !isOwnerBlocked(e.repo) && e.repo.blocker !== 'sibling');
}

/* ------------------------------------------------------------------ batching */

/**
 * Swedish-market repos, used only as the *proxy* grouping key until Decision D2
 * tells us which Hostinger account actually hosts what. A repo can state the
 * truth directly with `"hostinger_account": "..."` (which always wins) or
 * `"market": "se" | "py"`.
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

export function marketOf(repo) {
  return repo.market ?? (SE_REPOS.has(repo.name) ? 'se' : 'py');
}

/** The grouping key for one hPanel sitting. */
export function batchKey(repo) {
  if (repo.hostinger_account) return `account:${repo.hostinger_account}`;
  return `market:${marketOf(repo)}`;
}

/**
 * Minutes for a sitting of `n` DBs: a fixed panel-relearning cost amortized
 * across the batch, plus per-repo work. Three repos ≈ 45 min, matching
 * DESIGN.md §1a; one repo alone ≈ 25.
 */
export function batchMinutes(n) {
  return 15 + 10 * n;
}

/**
 * Compose DB sessions: group `db-setup` repos by Hostinger account (or the D2
 * market proxy), then chunk each group into sittings of at most `size`, in
 * leverage order. Batches are returned best-first by their top repo's score.
 */
export function dbBatches(portfolio, { size = 3, ...opts } = {}) {
  const scored = new Map(rank(portfolio, opts).map((e) => [e.repo.name, e]));
  const groups = new Map();

  for (const repo of dbBlockedRepos(portfolio)) {
    const key = batchKey(repo);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(scored.get(repo.name));
  }

  const batches = [];
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

/* ---------------------------------------------------------------------- CLI */

function bar(entry) {
  return `${entry.repo.name.padEnd(22)} ${String(entry.repo.pct).padStart(3)}%  ` +
    `${entry.repo.blocker.padEnd(26)} ${String(entry.minutes).padStart(2)}min  ` +
    `score ${entry.total.toFixed(1).padStart(6)}` +
    (entry.unblocks.length ? `  → unblocks ${entry.unblocks.join(', ')}` : '');
}

function main(argv) {
  validateCoefficients();
  const portfolio = load();
  const queue = launchQueue(portfolio);
  const batches = dbBatches(portfolio);

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
  queue.forEach((e, i) => console.log(`${String(i + 1).padStart(2)}. ${bar(e)}`));

  const shown = argv.includes('--batches') ? batches : batches.slice(0, 1);
  console.log(`\nPROPOSED DB SESSION${shown.length > 1 ? 'S' : ''} — ${batches.length} batch(es) available\n`);
  for (const b of shown) {
    const n = b.repos.length;
    console.log(`  ${b.minutes} min unblocks ${n} launch${n === 1 ? '' : 'es'}: ${b.repos.join(', ')}  [${b.key}]`);
    for (const e of b.entries) console.log(`      · ${bar(e)}`);
  }
  const totalMinutes = batches.reduce((s, b) => s + b.minutes, 0);
  console.log(
    `\n  Whole DB backlog: ${batches.length} sittings, ~${(totalMinutes / 60).toFixed(1)}h of hPanel time.\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
