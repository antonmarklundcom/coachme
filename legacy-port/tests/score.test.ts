/**
 * The scoring invariant, ported from the old test/score.test.js: a 95%-done
 * infra repo must outrank any early-stage repo under every reasonable
 * coefficient choice. It is the one property the whole coach rests on — if a
 * barely-started, well-connected repo can top the queue, the dashboard starts
 * pointing at the wrong work.
 */

import { describe, expect, it } from 'vitest';
import type { Repo } from '../lib/domain';
import {
  DEFAULT_COEFFICIENTS,
  batchKey,
  batchMinutes,
  dbBatches,
  launchQueue,
  moneyDistance,
  moneyQueue,
  rank,
  scoreRepo,
  validateCoefficients,
  type Coefficients,
} from '../lib/score';

function repo(partial: Partial<Repo> & { name: string }): Repo {
  return {
    id: Math.floor(Math.random() * 1e6),
    github_full_name: `antonmarklundcom/${partial.name}`,
    pct: 0,
    lane: 'early-open',
    blocker: 'none',
    tier: 'experiment',
    hostinger_account: null,
    market: null,
    next_step: null,
    open_prs: 0,
    merged_prs_30d: 0,
    live_url: null,
    live_url_ok: null,
    launched_at: null,
    unblocks: [],
    depends_on: [],
    related: [],
    unblocks_revenue: null,
    stage: 'building',
    revenue_model: null,
    price_note: null,
    currency: null,
    payment_rail: null,
    channel: null,
    sell_url: null,
    first_revenue_at: null,
    revenue_30d: null,
    stage_evidence: [],
    notes: null,
    cleared_blockers: [],
    snoozed_until: null,
    scope_review_due: false,
    scope_review_proposed: null,
    scope_reviews_unanswered: 0,
    kept_at: null,
    killed_at: null,
    last_commit_at: null,
    pushed_at: null,
    last_scan_at: null,
    last_scan_head_sha: null,
    blocked_scans: 0,
    newly_blocked_at: null,
    ...partial,
  } as Repo;
}

describe('coefficients', () => {
  it('accepts the defaults', () => {
    expect(() => validateCoefficients()).not.toThrow();
  });

  it('rejects coefficients where a 0% repo can outrank a 95% one', () => {
    const broken: Coefficients = { ...DEFAULT_COEFFICIENTS, unblockRevenue: 500 };
    expect(() => validateCoefficients(broken)).toThrow(/completion-dominance/);
  });

  it('rejects a tier table where infra is not the top tier', () => {
    const broken: Coefficients = { ...DEFAULT_COEFFICIENTS, tier: { infra: 5, revenue: 50, experiment: 0 } };
    expect(() => validateCoefficients(broken)).toThrow(/infra must be the highest/);
  });
});

describe('completion dominance', () => {
  const almostDone = repo({
    name: 'besikt',
    pct: 95,
    lane: 'launch-owner-blocked',
    blocker: 'db-setup',
    tier: 'infra',
  });

  // The strongest possible early-stage repo: top tier, two siblings freed, it
  // collects revenue, and no staleness decay because it was touched today.
  const bestEarly = repo({
    name: 'newthing',
    pct: 0,
    lane: 'early-open',
    blocker: 'facts',
    tier: 'infra',
    unblocks: ['besikt', 'other'],
    unblocks_revenue: true,
    last_commit_at: new Date().toISOString().slice(0, 10),
  });

  it('holds under the default coefficients', () => {
    const all = [almostDone, bestEarly, repo({ name: 'other' })];
    const a = scoreRepo(almostDone, all).total;
    const b = scoreRepo(bestEarly, all).total;
    expect(a).toBeGreaterThan(b);
  });

  it('holds across a sweep of sane coefficient choices', () => {
    const all = [almostDone, bestEarly, repo({ name: 'other' })];
    for (const completionSteep of [3, 6, 9]) {
      for (const unblockPerSibling of [5, 10, 15]) {
        for (const unblockRevenue of [6, 12, 18]) {
          for (const effortPerMinute of [0.1, 0.3, 0.6]) {
            const coef = {
              ...DEFAULT_COEFFICIENTS,
              completionSteep,
              unblockPerSibling,
              unblockRevenue,
              effortPerMinute,
            };
            validateCoefficients(coef);
            expect(scoreRepo(almostDone, all, { coef }).total).toBeGreaterThan(
              scoreRepo(bestEarly, all, { coef }).total
            );
          }
        }
      }
    }
  });

  it('is monotone in completion, all else equal', () => {
    const all: Repo[] = [];
    let previous = -Infinity;
    for (const pct of [0, 10, 40, 70, 85, 90, 95, 100]) {
      const total = scoreRepo(repo({ name: `r${pct}`, pct, tier: 'revenue', blocker: 'db-setup' }), all).total;
      expect(total).toBeGreaterThan(previous);
      previous = total;
    }
  });
});

describe('queue and lanes', () => {
  const repos = [
    repo({ name: 'besikt', pct: 95, blocker: 'db-setup', lane: 'launch-owner-blocked', tier: 'revenue' }),
    repo({ name: 'agentish', pct: 90, blocker: 'none', lane: 'launch-agent-drivable', tier: 'revenue' }),
    repo({ name: 'lowpct', pct: 30, blocker: 'db-setup', lane: 'early-owner-stalled', tier: 'revenue' }),
    repo({ name: 'killed', pct: 95, blocker: 'db-setup', lane: 'launch-owner-blocked', killed_at: '2026-08-01' }),
    repo({
      name: 'snoozing',
      pct: 95,
      blocker: 'db-setup',
      lane: 'launch-owner-blocked',
      snoozed_until: '2099-01-01',
    }),
  ];

  it('shows owner-blocked repos at ≥70% only', () => {
    const names = launchQueue(repos, { date: '2026-08-28' }).map((e) => e.repo.name);
    expect(names).toEqual(['besikt']);
  });

  it('leaves killed and snoozed repos out of every ranking', () => {
    const names = rank(repos, { date: '2026-08-28' }).map((e) => e.repo.name);
    expect(names).not.toContain('killed');
    expect(names).not.toContain('snoozing');
  });
});

describe('DB batching', () => {
  it('groups by Hostinger account when known, market proxy otherwise', () => {
    expect(batchKey(repo({ name: 'besikt', hostinger_account: 'acct-1' }))).toBe('account:acct-1');
    expect(batchKey(repo({ name: 'besikt' }))).toBe('market:se'); // SE_REPOS proxy
    expect(batchKey(repo({ name: 'qr' }))).toBe('market:py');
    expect(batchKey(repo({ name: 'qr', market: 'se' }))).toBe('market:se');
  });

  it('prices a sitting the way DESIGN.md §1a does', () => {
    expect(batchMinutes(1)).toBe(25);
    expect(batchMinutes(3)).toBe(45);
  });

  it('never mixes markets in one sitting and caps the size', () => {
    const repos = [
      repo({ name: 'besikt', pct: 95, blocker: 'db-setup', lane: 'launch-owner-blocked' }),
      repo({ name: 'byggmedia', pct: 80, blocker: 'db-setup', lane: 'launch-owner-blocked' }),
      repo({ name: 'qr', pct: 95, blocker: 'db-setup', lane: 'launch-owner-blocked' }),
      repo({ name: 'facturar', pct: 93, blocker: 'db-setup', lane: 'launch-owner-blocked' }),
      repo({ name: 'ecom', pct: 95, blocker: 'db-setup', lane: 'launch-owner-blocked' }),
      repo({ name: 'negocio', pct: 92, blocker: 'db-setup', lane: 'launch-owner-blocked' }),
    ];
    const batches = dbBatches(repos, { date: '2026-08-28' });
    for (const batch of batches) {
      expect(batch.repos.length).toBeLessThanOrEqual(3);
      const keys = new Set(batch.entries.map((e) => batchKey(e.repo)));
      expect(keys.size).toBe(1);
      expect(batch.minutes).toBe(batchMinutes(batch.repos.length));
    }
    // Best batch first, by its top repo's leverage.
    expect(batches[0].topScore).toBeGreaterThanOrEqual(batches[batches.length - 1].topScore);
  });
});

/**
 * Distance to money (plan.md §2, Decision D-H) — v3's correction to v2.
 *
 * v2 ranked by leverage alone, which is why thirty repos could carry a revenue
 * label while nothing recorded a price or a first customer: "almost finished"
 * and "almost earning" are not the same question, and the coach was only ever
 * asking the first one.
 */
describe('money distance', () => {
  it('puts a live repo at 60% ahead of a building repo at 95%', () => {
    const live = repo({ name: 'trabajo', stage: 'live', pct: 60, tier: 'revenue' });
    const building = repo({ name: 'byggmedia', stage: 'building', pct: 95, tier: 'revenue' });

    expect(moneyDistance(live)).toBeLessThan(moneyDistance(building));
    expect(moneyQueue([live, building]).map((e) => e.repo.name)).toEqual(['trabajo', 'byggmedia']);

    // …and the v2 order is the opposite one, which is the whole point.
    expect(rank([live, building]).map((e) => e.repo.name)).toEqual(['byggmedia', 'trabajo']);
  });

  it('scores an earning, finished repo at zero and a fresh repo at the far end', () => {
    expect(moneyDistance(repo({ name: 'x', stage: 'earning', pct: 100 }))).toBe(0);
    expect(moneyDistance(repo({ name: 'y', stage: 'building', pct: 0 }))).toBe(600);
  });

  it('breaks ties within a stage by completion, then by leverage', () => {
    const a = repo({ name: 'a', stage: 'deployable', pct: 95, tier: 'revenue' });
    const b = repo({ name: 'b', stage: 'deployable', pct: 80, tier: 'revenue' });
    expect(moneyQueue([b, a]).map((e) => e.repo.name)).toEqual(['a', 'b']);

    const c = repo({ name: 'c', stage: 'deployable', pct: 80, tier: 'revenue', unblocks_revenue: true });
    expect(moneyQueue([b, c]).map((e) => e.repo.name)).toEqual(['c', 'b']);
  });

  it('leaves the internal tools out of a queue about money', () => {
    const tool = repo({ name: 'coachme', stage: 'live', pct: 90, tier: 'infra', revenue_model: 'internal' });
    const product = repo({ name: 'besikt', stage: 'building', pct: 10, tier: 'revenue' });
    expect(moneyQueue([tool, product]).map((e) => e.repo.name)).toEqual(['besikt']);
  });

  it('keeps killed and snoozed repos out, like every other queue', () => {
    const dead = repo({ name: 'dead', stage: 'live', pct: 90, tier: 'revenue', killed_at: '2026-01-01' });
    expect(moneyQueue([dead])).toEqual([]);
  });
});
