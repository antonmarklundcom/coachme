import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  load,
  validate,
  ValidationError,
  clearBlocker,
  markLaunched,
  unblockedBy,
  ownerBlockedRepos,
  dbBlockedRepos,
  isOwnerBlocked,
  ownerMinutes,
} from '../src/portfolio.js';

const fresh = () => load();

test('the seeded portfolio validates', () => {
  const p = fresh();
  assert.equal(p.repos.length, 53);
});

test('validate rejects the shapes that would silently corrupt the queue', () => {
  const bad = [
    { repos: 'nope' },
    { repos: [{ name: 'a', pct: 101, lane: 'early-open', blocker: 'none', tier: 'infra' }] },
    { repos: [{ name: 'a', pct: 1, lane: 'nope', blocker: 'none', tier: 'infra' }] },
    { repos: [{ name: 'a', pct: 1, lane: 'early-open', blocker: 'nope', tier: 'infra' }] },
    { repos: [{ name: 'a', pct: 1, lane: 'early-open', blocker: 'none', tier: 'nope' }] },
    { repos: [
      { name: 'a', pct: 1, lane: 'early-open', blocker: 'none', tier: 'infra' },
      { name: 'a', pct: 1, lane: 'early-open', blocker: 'none', tier: 'infra' },
    ] },
    { repos: [{ name: 'a', pct: 1, lane: 'early-open', blocker: 'sibling', tier: 'infra', depends_on: ['ghost'] }] },
  ];
  for (const p of bad) assert.throws(() => validate(p), ValidationError);
});

test('clearBlocker moves a repo out of its owner-stalled lane and records the tick', () => {
  const p = fresh();
  clearBlocker(p, 'besikt', 'db-setup', { date: '2026-08-21' });
  const besikt = p.repos.find((r) => r.name === 'besikt');
  assert.equal(besikt.blocker, 'none');
  assert.equal(besikt.lane, 'launch-agent-drivable');
  assert.deepEqual(besikt.cleared_blockers, [{ blocker: 'db-setup', date: '2026-08-21' }]);
  assert.ok(!dbBlockedRepos(p).some((r) => r.name === 'besikt'));
  assert.ok(!ownerBlockedRepos(p).some((r) => r.name === 'besikt'));
  validate(p);
});

test('clearBlocker refuses to clear a blocker the repo does not have', () => {
  const p = fresh();
  assert.throws(() => clearBlocker(p, 'besikt', 'credentials'), ValidationError);
  assert.throws(() => clearBlocker(p, 'no-such-repo', 'db-setup'), ValidationError);
});

test('mid/early stalled repos land in their own unblocked lanes', () => {
  const p = fresh();
  clearBlocker(p, 'yt', 'db-setup');
  clearBlocker(p, 'studievagledare', 'confirmation');
  assert.equal(p.repos.find((r) => r.name === 'yt').lane, 'mid-agent-drivable');
  assert.equal(p.repos.find((r) => r.name === 'studievagledare').lane, 'early-open');
});

test('markLaunched finishes a repo', () => {
  const p = fresh();
  markLaunched(p, 'idioma', { date: '2026-08-22' });
  const idioma = p.repos.find((r) => r.name === 'idioma');
  assert.equal(idioma.pct, 100);
  assert.equal(idioma.blocker, 'none');
  assert.equal(idioma.launched, '2026-08-22');
  validate(p);
});

test('unblockedBy reads both declared and reverse sibling edges', () => {
  const p = fresh();
  assert.deepEqual(unblockedBy(p, 'propia.node').sort(), ['app.propia', 'terreno']);
  assert.deepEqual(unblockedBy(p, 'besikt'), []);
});

test('sibling-blocked repos are never owner-blocked work', () => {
  const p = fresh();
  const terreno = p.repos.find((r) => r.name === 'terreno');
  assert.equal(isOwnerBlocked(terreno), false);
  assert.equal(ownerMinutes(terreno), 0);
});
