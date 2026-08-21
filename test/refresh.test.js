import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, validate, clearBlocker } from '../src/portfolio.js';
import {
  planScan,
  applyScan,
  stalenessSweep,
  autoProposeSnooze,
  STALE_DAYS,
  BLOCKED_SCANS_LIMIT,
} from '../src/refresh.js';
import { harvest } from '../src/harvest.js';
import { buildModel, renderDashboard, DECISIONS_PATH, CONFIG_PATH } from '../src/render.js';
import { readFileSync } from 'node:fs';

const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')).decisions;
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const fresh = () => load();
const page = (p) => renderDashboard(buildModel(p, { config, decisions }));
const NOW = Date.parse('2026-08-24T12:00:00Z');
const listing = (over) => Object.fromEntries(Object.entries(over));

/* ------------------------------------------------------------- planning */

test('only repos pushed since their last scan are deep-read', () => {
  const p = fresh();
  const remote = listing({
    besikt: { pushed_at: '2026-08-20T00:00:00Z' }, // after the audit baseline
    qr: { pushed_at: '2026-07-01T00:00:00Z' }, // before it
    ecom: { pushed_at: '2026-08-23T00:00:00Z' },
  });
  const { deep, skipped, unknown } = planScan(p, remote, { now: NOW });

  assert.deepEqual(deep.map((d) => d.name).sort(), ['besikt', 'ecom']);
  assert.deepEqual(skipped.map((d) => d.name), ['qr']);
  assert.equal(unknown.length, 50, 'repos absent from the listing are reported, not scanned');
});

test('the audit counts as a baseline, so the first run is incremental', () => {
  const p = fresh();
  assert.equal(p.meta.baseline_scan, '2026-08-01');
  const quiet = planScan(p, listing({ anillos: { pushed_at: '2026-07-20T00:00:00Z' } }), { now: NOW });
  assert.equal(quiet.deep.length, 0, 'an untouched repo is not re-read just because it has no last_scan');
  assert.match(quiet.skipped[0].why, /unchanged since the audit/);
});

test('a stale record is re-read even with no new commits', () => {
  const p = fresh();
  const remote = listing({ anillos: { pushed_at: '2026-07-01T00:00:00Z' } });
  const later = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(planScan(p, remote, { now: later }).deep[0].name, 'anillos');
});

test('archived repos are skipped and forced repos are not', () => {
  const p = fresh();
  const remote = listing({
    anillos: { pushed_at: '2026-07-01T00:00:00Z', archived: true },
    qr: { pushed_at: '2026-07-01T00:00:00Z' },
  });
  const { deep, skipped } = planScan(p, remote, { now: NOW, force: ['qr'] });
  assert.deepEqual(deep.map((d) => d.name), ['qr']);
  assert.match(skipped.find((s) => s.name === 'anillos').why, /archived/);
});

/* -------------------------------------------------------------- applying */

test('progress is applied, and the scan records what it read', () => {
  const p = fresh();
  const { changes } = applyScan(p, { 'propia.node': { pct: 91, last_commit: '2026-08-23', next_step: 'point the domain', open_prs: 2, merged_prs: 4 } }, { date: '2026-08-24' });
  const repo = p.repos.find((r) => r.name === 'propia.node');

  assert.equal(repo.pct, 91);
  assert.equal(repo.last_scan, '2026-08-24');
  assert.equal(repo.next_step, 'point the domain');
  assert.equal(repo.merged_prs, 4);
  assert.deepEqual(changes, ['propia.node: 88% → 91%']);
  validate(p);
});

test('a percentage that FALLS is never applied — it becomes a question', () => {
  const p = fresh();
  const { changes, drift } = applyScan(p, { besikt: { pct: 60 } }, { date: '2026-08-24' });
  assert.deepEqual(changes, []);
  assert.equal(p.repos.find((r) => r.name === 'besikt').pct, 95, 'the record is not lowered');
  assert.equal(drift.length, 1);
  assert.match(drift[0].note, /reads besikt as 60% done, the record says 95%/);
});

test('the drift guard: a scan never re-blocks what the owner ticked clear', () => {
  const p = fresh();
  clearBlocker(p, 'qr', 'db-setup', { date: '2026-08-22' });

  const { changes, drift } = applyScan(p, { qr: { blocker: 'db-setup' } }, { date: '2026-08-24' });
  const qr = p.repos.find((r) => r.name === 'qr');

  assert.equal(qr.blocker, 'none', 'the human tick stands');
  assert.deepEqual(changes, []);
  assert.match(drift[0].note, /you marked qr unblocked, but the scan still sees/);
  assert.ok(qr.drift_note);
});

test('a repo the owner never ticked IS re-blocked, and flagged as new work', () => {
  const p = fresh();
  const { changes } = applyScan(p, { trabajo: { blocker: 'credentials', lane: 'launch-owner-blocked' } }, { date: '2026-08-24' });
  const repo = p.repos.find((r) => r.name === 'trabajo');

  assert.equal(repo.blocker, 'credentials');
  assert.equal(repo.newly_blocked, '2026-08-24');
  assert.ok(changes.includes('trabajo: newly blocked on you'));
  validate(p);
});

test('a repo blocked on the owner across scans is called out', () => {
  const p = fresh();
  let changes = [];
  for (let i = 0; i < BLOCKED_SCANS_LIMIT; i++) {
    ({ changes } = applyScan(p, { besikt: {} }, { date: '2026-08-24' }));
  }
  assert.equal(p.repos.find((r) => r.name === 'besikt').blocked_scans, BLOCKED_SCANS_LIMIT);
  assert.ok(changes.some((c) => /owner-blocked for 3 scans running/.test(c)));
});

test('clearing a blocker resets the stuck counter', () => {
  const p = fresh();
  applyScan(p, { besikt: {} }, { date: '2026-08-24' });
  applyScan(p, { besikt: { blocker: 'none', lane: 'launch-agent-drivable' } }, { date: '2026-08-25' });
  assert.equal(p.repos.find((r) => r.name === 'besikt').blocked_scans, undefined);
});

test('a live URL that answers marks the repo launched', () => {
  const p = fresh();
  const { launches } = applyScan(p, { idioma: { live_url_ok: true } }, { date: '2026-08-24' });
  const repo = p.repos.find((r) => r.name === 'idioma');
  assert.deepEqual(launches, ['idioma']);
  assert.equal(repo.pct, 100);
  assert.equal(repo.blocker, 'none');
  assert.equal(repo.launched, '2026-08-24');
  validate(p);
});

test('a scan result for a repo that is not in the portfolio is ignored, not fatal', () => {
  const p = fresh();
  const { changes } = applyScan(p, { 'brand-new-repo': { pct: 10 } }, { date: '2026-08-24' });
  assert.match(changes[0], /not in the portfolio/);
  validate(p);
});

/* -------------------------------------------------- drift round-trips to the page */

test('a drift item reaches the dashboard and a tick clears it', () => {
  const p = fresh();
  clearBlocker(p, 'qr', 'db-setup', { date: '2026-08-22' });
  applyScan(p, { qr: { blocker: 'db-setup' } }, { date: '2026-08-24' });

  let html = page(p);
  assert.match(html, /data-act="verify" data-repo="qr"/);
  assert.match(html, /you marked qr unblocked/);

  html = html.replace(/(data-act="verify" data-repo="qr"[^>]*)>/, '$1 checked>');
  const { portfolio, changes } = harvest(html, p);
  assert.deepEqual(changes, ['qr: drift confirmed resolved']);
  assert.equal(portfolio.repos.find((r) => r.name === 'qr').drift_note, undefined);
  assert.doesNotMatch(page(portfolio), /data-act="verify" data-repo="qr"/);
});

test('merged PRs show up in the agent lane as evidence of movement', () => {
  const p = fresh();
  applyScan(p, { trabajo: { merged_prs: 3, open_prs: 1, last_commit: '2026-08-23' } }, { date: '2026-08-24' });
  const model = buildModel(p, { config, decisions, now: NOW });
  const row = model.agent.find((r) => r.name === 'trabajo');
  assert.equal(row.merged, 3);
  assert.equal(row.has_open, true);
  assert.match(page(p), /3 merged/);
});

/* ---------------------------------------------------------------- sweep */

test('untouched early-stage repos land in the scope review; nearly-done ones never do', () => {
  const p = fresh();
  const old = '2026-06-01';
  for (const name of ['anillos', 'besikt']) p.repos.find((r) => r.name === name).last_commit = old;

  const flagged = stalenessSweep(p, { now: NOW, days: STALE_DAYS });
  assert.ok(flagged.includes('anillos'));
  assert.ok(!flagged.includes('besikt'), 'a 95% repo has already answered "should this exist?"');
});

test('a repo with recent activity is not flagged', () => {
  const p = fresh();
  p.repos.find((r) => r.name === 'anillos').last_commit = '2026-08-20';
  assert.deepEqual(stalenessSweep(p, { now: NOW }), []);
});

test('two ignored scope reviews auto-propose a snooze, and never apply it', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.scope_review_due = true;

  assert.deepEqual(autoProposeSnooze(p), []);
  assert.deepEqual(autoProposeSnooze(p), ['anillos']);
  assert.equal(repo.scope_review_proposed, 'snooze');
  assert.equal(repo.scope_review, undefined, 'a proposal is not a decision');
  assert.match(page(p), /no answer twice — proposed: snooze/);
});

test('an answered scope review stops being asked about', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.scope_review_due = true;
  repo.scope_review = 'keep';
  assert.deepEqual(autoProposeSnooze(p), []);
  assert.deepEqual(stalenessSweep(p, { now: NOW }), []);
});
