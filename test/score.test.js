import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, clearBlocker, BLOCKER_MINUTES } from '../src/portfolio.js';
import {
  DEFAULT_COEFFICIENTS,
  validateCoefficients,
  scoreRepo,
  rank,
  launchQueue,
  agentLane,
  dbBatches,
  batchKey,
  batchMinutes,
  marketOf,
} from '../src/score.js';

const fresh = () => load();
const MAX_MINUTES = Math.max(...Object.values(BLOCKER_MINUTES));

/**
 * "Sane" coefficient space. Every combination in here must preserve the
 * completion-dominance invariant — that is the point of the ranges.
 */
const SANE = {
  completionLinear: [0.4, 0.6, 0.8],
  completionSteep: [5, 6.5, 8],
  steepFrom: [80, 85, 88],
  unblockPerSibling: [5, 10, 12],
  unblockRevenue: [5, 12, 15],
  tierInfra: [10, 20, 25],
  effortPerMinute: [0.1, 0.25, 0.4],
};

function* saneCoefficients() {
  for (const completionLinear of SANE.completionLinear)
    for (const completionSteep of SANE.completionSteep)
      for (const steepFrom of SANE.steepFrom)
        for (const unblockPerSibling of SANE.unblockPerSibling)
          for (const unblockRevenue of SANE.unblockRevenue)
            for (const tierInfra of SANE.tierInfra)
              for (const effortPerMinute of SANE.effortPerMinute)
                yield {
                  ...DEFAULT_COEFFICIENTS,
                  completionLinear,
                  completionSteep,
                  steepFrom,
                  unblockPerSibling,
                  unblockRevenue,
                  effortPerMinute,
                  tier: { infra: tierInfra, revenue: tierInfra / 2, experiment: 0 },
                };
}

test('the default coefficients satisfy the completion-dominance invariant', () => {
  validateCoefficients(DEFAULT_COEFFICIENTS, { maxMinutes: MAX_MINUTES });
});

test('validateCoefficients rejects a tuning that lets connections beat completion', () => {
  assert.throws(() =>
    validateCoefficients(
      { ...DEFAULT_COEFFICIENTS, completionSteep: 0, completionLinear: 0.1, unblockPerSibling: 100 },
      { maxMinutes: MAX_MINUTES }
    )
  );
});

test('a 95% infra repo outranks every 0% repo under every sane coefficient choice', () => {
  const p = fresh();
  // Worst-case 95% infra repo: most expensive blocker, no siblings, no revenue.
  const ninetyFive = { name: 'ninetyfive', pct: 95, lane: 'launch-owner-blocked', blocker: 'owner-setup-unclassified', tier: 'infra' };
  // Best-case 0% repos: fully connected, revenue-collecting, free to unblock.
  const zeros = [
    { name: 'zero-connected', pct: 0, lane: 'early-open', blocker: 'none', tier: 'infra', unblocks: ['a', 'b', 'c'], unblocks_revenue: true },
    { name: 'zero-plain', pct: 0, lane: 'early-open', blocker: 'none', tier: 'infra' },
  ];
  const stub = { repos: [ninetyFive, ...zeros, { name: 'a', pct: 0 }, { name: 'b', pct: 0 }, { name: 'c', pct: 0 }] };

  let checked = 0;
  for (const coef of saneCoefficients()) {
    validateCoefficients(coef, { maxMinutes: MAX_MINUTES });
    const high = scoreRepo(ninetyFive, stub, { coef }).total;
    for (const zero of zeros) {
      const low = scoreRepo(zero, stub, { coef }).total;
      assert.ok(high > low, `95% (${high}) must beat 0% ${zero.name} (${low}) with ${JSON.stringify(coef)}`);
    }
    checked++;
  }
  assert.ok(checked > 500, `expected a real sweep, checked ${checked}`);
});

test('scoring is monotone in completion, all else equal', () => {
  const stub = { repos: [] };
  const base = { name: 'x', pct: 0, lane: 'early-open', blocker: 'db-setup', tier: 'revenue' };
  let previous = -Infinity;
  for (let pct = 0; pct <= 100; pct += 1) {
    const total = scoreRepo({ ...base, pct }, stub).total;
    assert.ok(total > previous, `score must strictly increase at ${pct}%`);
    previous = total;
  }
});

test('staleness only ever touches early-stage repos', () => {
  const stub = { repos: [] };
  const old = '2020-01-01T00:00:00Z';
  const nearlyDone = { name: 'a', pct: 95, lane: 'launch-owner-blocked', blocker: 'db-setup', tier: 'revenue', last_commit: old };
  const early = { name: 'b', pct: 10, lane: 'early-open', blocker: 'none', tier: 'experiment', last_commit: old };
  assert.equal(scoreRepo(nearlyDone, stub).staleness, 0);
  assert.ok(scoreRepo(early, stub).staleness > 0);
  assert.equal(scoreRepo({ ...early, last_commit: undefined }, stub).staleness, 0);
});

test('the launch queue is owner-blocked repos ≥70%, in descending score order', () => {
  const p = fresh();
  const queue = launchQueue(p);
  assert.equal(queue.length, 20);
  for (const e of queue) assert.ok(e.repo.pct >= 70);
  for (let i = 1; i < queue.length; i++) assert.ok(queue[i - 1].total >= queue[i].total);
  assert.ok(!queue.some((e) => e.repo.blocker === 'none'));
  assert.ok(!queue.some((e) => e.repo.blocker === 'sibling'));
});

test('the agent lane excludes owner-blocked and sibling-blocked repos', () => {
  const p = fresh();
  const lane = agentLane(p);
  assert.ok(lane.some((e) => e.repo.name === 'trabajo'));
  assert.ok(!lane.some((e) => e.repo.name === 'besikt'));
  assert.ok(!lane.some((e) => e.repo.name === 'terreno'));
});

test('propia.node scores above an equally complete repo with no siblings', () => {
  const p = fresh();
  const scored = new Map(rank(p).map((e) => [e.repo.name, e]));
  const propia = scored.get('propia.node');
  assert.deepEqual(propia.unblocks.sort(), ['app.propia', 'terreno']);
  const twin = scoreRepo(
    { ...p.repos.find((r) => r.name === 'propia.node'), name: 'twin', unblocks: [] },
    { repos: [] }
  );
  assert.ok(propia.total > twin.total);
});

/* ------------------------------------------------------------- batching */

test('batches group by Hostinger account when known, market proxy otherwise', () => {
  const p = fresh();
  assert.equal(batchKey({ name: 'besikt' }), 'market:se');
  assert.equal(batchKey({ name: 'qr' }), 'market:py');
  assert.equal(batchKey({ name: 'qr', hostinger_account: 'acct-2' }), 'account:acct-2');
  assert.equal(marketOf({ name: 'qr', market: 'se' }), 'se');

  for (const batch of dbBatches(p)) {
    const keys = new Set(batch.repos.map((n) => batchKey(p.repos.find((r) => r.name === n))));
    assert.equal(keys.size, 1, `batch ${batch.repos} mixes ${[...keys]}`);
  }
});

test('every db-blocked repo lands in exactly one batch of at most three', () => {
  const p = fresh();
  const batches = dbBatches(p);
  const placed = batches.flatMap((b) => b.repos);
  const expected = p.repos.filter((r) => r.blocker === 'db-setup').map((r) => r.name);
  assert.equal(placed.length, new Set(placed).size, 'a repo appears in two batches');
  assert.deepEqual([...placed].sort(), [...expected].sort());
  for (const b of batches) assert.ok(b.repos.length <= 3 && b.repos.length >= 1);
});

test('batch minutes match the design: three DBs in one sitting ≈ 45 min', () => {
  assert.equal(batchMinutes(3), 45);
  assert.ok(batchMinutes(1) < batchMinutes(2) && batchMinutes(2) < batchMinutes(3));
  assert.ok(batchMinutes(3) < 3 * batchMinutes(1), 'batching must amortize the panel cost');
});

test('the best batch leads, and members are in leverage order', () => {
  const p = fresh();
  const batches = dbBatches(p);
  for (let i = 1; i < batches.length; i++) assert.ok(batches[i - 1].topScore >= batches[i].topScore);
  for (const b of batches) {
    for (let i = 1; i < b.entries.length; i++) assert.ok(b.entries[i - 1].total >= b.entries[i].total);
  }
});

test('clearing a blocker removes the repo from the queue and re-composes batches', () => {
  const p = fresh();
  const before = dbBatches(p);
  assert.ok(before[0].repos.includes('qr'));
  clearBlocker(p, 'qr', 'db-setup');
  const after = dbBatches(p);
  assert.ok(!after.flatMap((b) => b.repos).includes('qr'));
  assert.ok(!launchQueue(p).some((e) => e.repo.name === 'qr'));
  assert.equal(after.flatMap((b) => b.repos).length, before.flatMap((b) => b.repos).length - 1);
});
