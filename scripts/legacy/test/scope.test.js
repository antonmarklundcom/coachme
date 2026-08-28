import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, validate, markLaunched } from '../src/portfolio.js';
import {
  isSnoozed,
  isKilled,
  isDormant,
  reviewDue,
  applyScopeAnswers,
  wakeSnoozed,
  streakDays,
  momentum,
  SNOOZE_DAYS,
  REVIEW_INTERVAL_DAYS,
} from '../src/scope.js';
import { rank, launchQueue, dbBatches } from '../src/score.js';
import { stalenessSweep } from '../src/refresh.js';
import { harvest } from '../src/harvest.js';
import { runDaily } from '../src/run.js';
import { buildModel, renderDashboard, DECISIONS_PATH, CONFIG_PATH } from '../src/render.js';

const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')).decisions;
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const fresh = () => load();
const page = (p, date = '2026-08-24') =>
  renderDashboard(buildModel(p, { config, decisions, now: Date.parse(`${date}T12:00:00Z`) }));
const DATE = '2026-08-24';

/* ------------------------------------------------------------- answers */

test('a snooze puts the repo to sleep for 90 days and clears the question', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.scope_review_due = true;
  repo.scope_review = 'snooze';

  const changes = applyScopeAnswers(p, { date: DATE });
  assert.deepEqual(changes, ['anillos: snoozed until 2026-11-22']);
  assert.equal(repo.scope_review_due, undefined);
  assert.equal(repo.scope_review, undefined);
  assert.equal(isSnoozed(repo, DATE), true);
  assert.equal(isSnoozed(repo, '2026-12-01'), false, `a snooze is ${SNOOZE_DAYS} days, not forever`);
  validate(p);
});

test('a kill is a flag in this repo and nothing else', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.scope_review = 'kill';
  const changes = applyScopeAnswers(p, { date: DATE });

  assert.match(changes[0], /nothing archived on GitHub/);
  assert.equal(repo.killed, DATE);
  assert.equal(isKilled(repo), true);
  validate(p);
});

test('keeping a repo records the answer and stops the asking', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.scope_review_due = true;
  repo.scope_review = 'keep';
  applyScopeAnswers(p, { date: DATE });
  assert.equal(repo.kept, DATE);
  assert.equal(isDormant(repo, DATE), false, 'keeping means it stays in the pool');
});

test('an expired snooze wakes the repo back up', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.snoozed_until = '2026-08-20';
  assert.deepEqual(wakeSnoozed(p, { date: DATE }), ['anillos']);
  assert.equal(repo.snoozed_until, undefined);
  assert.deepEqual(wakeSnoozed(p, { date: DATE }), [], 'and only once');
});

/* --------------------------------------------------------- consequences */

test('dormant repos leave the queue, the batches and the page', () => {
  const p = fresh();
  const qr = p.repos.find((r) => r.name === 'qr');
  qr.scope_review = 'kill';
  applyScopeAnswers(p, { date: DATE });

  assert.ok(!rank(p, { date: DATE }).some((e) => e.repo.name === 'qr'));
  assert.ok(!launchQueue(p, { date: DATE }).some((e) => e.repo.name === 'qr'));
  assert.ok(!dbBatches(p, { date: DATE }).flatMap((b) => b.repos).includes('qr'));
  assert.doesNotMatch(page(p), /data-act="clear" data-repo="qr"/);
});

test('nothing disappears silently — put-down repos are listed', () => {
  const p = fresh();
  p.repos.find((r) => r.name === 'anillos').scope_review = 'snooze';
  p.repos.find((r) => r.name === 'productos').scope_review = 'kill';
  applyScopeAnswers(p, { date: DATE });

  const html = page(p);
  assert.match(html, /2 repos you have put down/);
  assert.match(html, /snoozed until 2026-11-22/);
  assert.match(html, /killed/);
});

test('a killed repo stops counting toward the hPanel backlog', () => {
  const p = fresh();
  const before = momentum(p, null, { date: DATE }).remaining_minutes;
  for (const name of ['qr', 'facturar', 'ecom']) p.repos.find((r) => r.name === name).scope_review = 'kill';
  applyScopeAnswers(p, { date: DATE });
  assert.ok(momentum(p, null, { date: DATE }).remaining_minutes < before);
});

/* -------------------------------------------------------- monthly rhythm */

test('the scope question is monthly, not weekly', () => {
  const p = fresh();
  p.repos.find((r) => r.name === 'anillos').last_commit = '2026-06-01';
  const now = Date.parse(`${DATE}T12:00:00Z`);

  assert.equal(reviewDue(p, { date: DATE }), true, 'never asked yet');
  assert.deepEqual(stalenessSweep(p, { now, date: DATE }), ['anillos']);

  p.meta.scope_review_last = DATE;
  p.repos.find((r) => r.name === 'seguro').last_commit = '2026-06-01';
  assert.equal(reviewDue(p, { date: '2026-08-31' }), false, 'a week later is nagging');
  assert.deepEqual(stalenessSweep(p, { now: Date.parse('2026-08-31T12:00:00Z'), date: '2026-08-31' }), []);

  const later = '2026-09-30';
  assert.equal(reviewDue(p, { date: later }), true, `${REVIEW_INTERVAL_DAYS} days on, ask again`);
});

test('a sleeping repo is never asked about again while it sleeps', () => {
  const p = fresh();
  const repo = p.repos.find((r) => r.name === 'anillos');
  repo.last_commit = '2026-06-01';
  repo.snoozed_until = '2026-11-22';
  assert.deepEqual(stalenessSweep(p, { now: Date.parse(`${DATE}T12:00:00Z`), date: DATE }), []);
});

/* -------------------------------------------------------------- streak */

test('the streak counts days since an ask was dropped, not days of activity', () => {
  const nudges = { history: [] };
  assert.equal(streakDays(nudges, { date: DATE }), 0, 'nothing has happened yet');

  nudges.history.push({ date: '2026-08-17', type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });
  assert.equal(streakDays(nudges, { date: DATE }), 7);

  // A quiet day does not break it — silence is a feature, not a failure.
  nudges.history.push({ date: '2026-08-23', type: 'db-session', repos: ['qr'], outcome: 'acted', pushed: true });
  assert.equal(streakDays(nudges, { date: DATE }), 7);

  nudges.history.push({ date: DATE, type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });
  assert.equal(streakDays(nudges, { date: DATE }), 0, 'dropping one resets it');
});

test('the momentum strip reports launches, sessions and the burn-down', () => {
  const p = fresh();
  markLaunched(p, 'idioma', { date: '2026-08-20' });
  const nudges = {
    history: [
      { date: '2026-08-19', type: 'db-session', repos: ['idioma'], outcome: 'acted', pushed: true },
      { date: '2026-08-21', type: 'db-session', repos: ['qr'], outcome: 'acted', pushed: true },
    ],
  };
  const m = momentum(p, nudges, { date: DATE, baselineMinutes: 195 });

  assert.equal(m.launches, 1);
  assert.deepEqual(m.launch_names, ['idioma']);
  assert.equal(m.sessions, 2);
  assert.equal(m.baseline_h, '3.3');
  assert.ok(m.burned_pct > 0, 'a launch burns the bar down');
  assert.equal(m.streak, 5, 'no ask has been dropped since the history began');
});

test('an old launch does not keep counting for the month', () => {
  const p = fresh();
  markLaunched(p, 'idioma', { date: '2026-06-01' });
  assert.equal(momentum(p, null, { date: DATE }).launches, 0);
});

/* ------------------------------------------------------ round trip */

test('scope answers round-trip from the page through a run', () => {
  const p = fresh();
  p.repos.find((r) => r.name === 'anillos').scope_review_due = true;

  let html = page(p);
  assert.match(html, /data-act="scope" data-repo="anillos" data-choice="snooze"/);
  html = html.replace(/(data-act="scope" data-repo="anillos" data-choice="snooze"[^>]*)>/, '$1 checked>');

  const { summary, portfolio } = runDaily({
    portfolio: p,
    nudges: { history: [], state: { muted: {}, shrunk_ignored: {} } },
    config,
    decisions,
    html,
    date: DATE,
  });

  assert.ok(summary.harvested.includes('anillos scope review: snooze'));
  assert.ok(summary.harvested.includes('anillos: snoozed until 2026-11-22'));
  const repo = portfolio.repos.find((r) => r.name === 'anillos');
  assert.equal(isSnoozed(repo, DATE), true);
  assert.equal(repo.scope_review_due, undefined, 'the question is answered and gone');
});
