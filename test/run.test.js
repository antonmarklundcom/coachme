import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from '../src/portfolio.js';
import { runDaily } from '../src/run.js';
import { renderDashboard, buildModel, DECISIONS_PATH, CONFIG_PATH } from '../src/render.js';

const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')).decisions;
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const emptyNudges = () => ({ history: [], state: { muted: {}, shrunk_ignored: {} } });
const page = (p) => renderDashboard(buildModel(p, { config, decisions }));
const MON = '2026-08-24';
const TUE = '2026-08-25';

const run = (portfolio, nudges, opts = {}) =>
  runDaily({ portfolio, nudges, config, decisions, ...opts });

test('a fired run produces the right nudge from the seeded state', () => {
  const { summary } = run(load(), emptyNudges(), { date: MON });
  assert.equal(summary.push, true);
  assert.equal(summary.type, 'db-session');
  assert.deepEqual(summary.repos, ['qr', 'facturar', 'ecom']);
  assert.match(summary.title, /45 min unblocks 3 launches/);
});

test('a second run the same day stays silent', () => {
  const portfolio = load();
  const nudges = emptyNudges();
  assert.equal(run(portfolio, nudges, { date: MON }).summary.push, true);
  const second = run(portfolio, nudges, { date: MON }).summary;
  assert.equal(second.push, false);
  assert.match(second.reason, /already decided today/);
  assert.equal(second.commit_needed, false, 'a silent re-run has nothing to commit');
});

test('a run harvests the page before it decides', () => {
  const portfolio = load();
  const ticked = page(portfolio).replace(
    /(data-act="clear" data-repo="qr"[^>]*)>/,
    '$1 checked>'
  );
  const { summary, portfolio: after } = run(portfolio, emptyNudges(), { date: MON, html: ticked });

  assert.deepEqual(summary.harvested, ['qr: db-setup cleared']);
  assert.equal(after.repos.find((r) => r.name === 'qr').blocker, 'none');
  assert.ok(!summary.repos.includes('qr'), 'the cleared repo is not what today is about');
});

test('the run resolves yesterday\'s nudge from what the harvest changed', () => {
  const portfolio = load();
  const nudges = emptyNudges();
  nudges.history.push({ date: MON, type: 'db-session', repos: ['qr', 'facturar', 'ecom'], outcome: 'pending', pushed: true });

  const ticked = page(portfolio).replace(/(data-act="clear" data-repo="qr"[^>]*)>/, '$1 checked>');
  const { summary } = run(portfolio, nudges, { date: TUE, html: ticked });

  assert.deepEqual(summary.resolved, [`${MON} db-session → acted`]);
  assert.equal(nudges.history[0].outcome, 'acted');
});

test('an untouched page resolves yesterday as ignored', () => {
  const portfolio = load();
  const nudges = emptyNudges();
  nudges.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'pending', pushed: true });
  const { summary } = run(portfolio, nudges, { date: TUE, html: page(portfolio) });
  assert.deepEqual(summary.resolved, [`${MON} db-session → ignored`]);
});

test('the page it renders reflects the decision it just made', () => {
  const portfolio = load();
  const nudges = emptyNudges();
  // Two prior asks about the top batch, so today's decision is the shrink.
  nudges.history.push({ date: '2026-08-22', type: 'db-session', repos: ['qr', 'facturar', 'ecom'], outcome: 'ignored', pushed: true });
  nudges.history.push({ date: '2026-08-23', type: 'db-session', repos: ['qr', 'facturar', 'ecom'], outcome: 'ignored', pushed: true });

  const { summary, page: html } = run(portfolio, nudges, { date: MON });
  assert.equal(summary.type, 'shrunk');
  assert.match(html, /5 min: create the database and whitelist your IP for qr/);
  assert.doesNotMatch(html, /45 min unblocks 3 launches/);
});

test('a run is a pure function of its inputs — nothing is written by runDaily itself', () => {
  const before = JSON.stringify(load());
  run(load(), emptyNudges(), { date: MON });
  assert.equal(JSON.stringify(load()), before, 'data/portfolio.json must be untouched on disk');
});
