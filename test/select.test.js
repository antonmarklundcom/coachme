import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, markLaunched, clearBlocker } from '../src/portfolio.js';
import {
  CAPS,
  selectNudge,
  resolveOutcomes,
  applyDecision,
  weekKey,
  pushesOn,
  pushesInWeek,
  chainLength,
  inCooldown,
} from '../src/select.js';
import { DECISIONS_PATH } from '../src/render.js';

const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')).decisions;
const fresh = () => load();
const emptyNudges = () => ({ history: [], state: { muted: {}, shrunk_ignored: {} } });

// 2026-08-24 is a Monday; the week runs Mon 24 → Sun 30.
const MON = '2026-08-24';
const TUE = '2026-08-25';
const WED = '2026-08-26';
const THU = '2026-08-27';
const FRI = '2026-08-28';
const SAT = '2026-08-29';
const SUN = '2026-08-30';

const decide = (p, n, date) => selectNudge(p, n, { date, decisions });

/** Run one day and commit its outcome, the way the Routine does. */
function runDay(p, n, date, { acted = false } = {}) {
  resolveOutcomes(n, { date, touched: acted ? (n.history.at(-1)?.repos ?? []) : [] });
  const d = decide(p, n, date);
  applyDecision(p, n, d);
  return d;
}

/* ------------------------------------------------------------- the caps */

test('Sunday is always silent, whatever the ladder says', () => {
  const d = decide(fresh(), emptyNudges(), SUN);
  assert.equal(d.push, false);
  assert.match(d.reason, /Sunday/);
});

test('never more than one push per day', () => {
  const p = fresh();
  const n = emptyNudges();
  assert.equal(decide(p, n, MON).push, true);
  applyDecision(p, n, decide(p, n, MON));
  const second = decide(p, n, MON);
  assert.equal(second.push, false);
  assert.match(second.reason, /already decided today/);
});

test('a silent decision still settles the day — a re-run cannot turn it into a push', () => {
  const p = fresh();
  const n = emptyNudges();
  for (const repo of ['qr', 'facturar', 'ecom']) n.state.shrunk_ignored[repo] = CAPS.shrunkIgnoredLimit;
  n.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });
  n.history.push({ date: TUE, type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });

  const first = decide(p, n, WED);
  assert.equal(first.type, 'question');
  assert.equal(first.push, false);
  applyDecision(p, n, first);

  const second = decide(p, n, WED);
  assert.equal(second.push, false, 'a silent day must not be upgraded to a push by a second run');
  assert.match(second.reason, /already decided today/);
});

test('never more than five pushes per week', () => {
  const p = fresh();
  const n = emptyNudges();
  for (const [i, day] of [MON, TUE, WED, THU, FRI].entries()) {
    n.history.push({ date: day, type: `filler-${i}`, repos: [], outcome: 'acted', pushed: true });
  }
  assert.equal(pushesInWeek(n, SAT), CAPS.maxPerWeek);
  const d = decide(p, n, SAT);
  assert.equal(d.push, false);
  assert.match(d.reason, /weekly cap/);
});

test('the weekly cap resets on Monday, not on a rolling window', () => {
  const n = emptyNudges();
  for (const day of [MON, TUE, WED, THU, FRI]) n.history.push({ date: day, type: 'x', repos: [], outcome: 'ignored', pushed: true });
  assert.equal(pushesInWeek(n, SAT), 5, 'Saturday is the same week as Monday');
  assert.equal(pushesInWeek(n, '2026-08-31'), 0, 'the next Monday starts fresh');
  assert.equal(weekKey(SUN), weekKey(MON));
  assert.notEqual(weekKey('2026-08-31'), weekKey(MON));
});

test('a silent decision does not consume the daily or weekly budget', () => {
  const n = emptyNudges();
  n.history.push({ date: MON, type: 'question', repos: ['qr'], outcome: 'pending', pushed: false });
  assert.equal(pushesOn(n, MON), 0);
  assert.equal(pushesInWeek(n, MON), 0);
});

/* ------------------------------------------------- repeat, shrink, question */

test('the same nudge never runs three days in a row — day three shrinks', () => {
  const p = fresh();
  const n = emptyNudges();

  const day1 = runDay(p, n, MON);
  assert.equal(day1.type, 'db-session');
  const day2 = runDay(p, n, TUE);
  assert.equal(day2.type, 'db-session');
  assert.equal(chainLength(n, ['qr', 'facturar', 'ecom'], WED), 2);

  const day3 = runDay(p, n, WED);
  assert.equal(day3.type, 'shrunk', 'day three must shrink, not repeat');
  assert.equal(day3.push, true);
  assert.equal(day3.minutes, 5);
  assert.match(day3.title, /5 minutes/);
  assert.equal(p.session.shrink, true, 'the dashboard card shrinks to match');
});

test('a shrunk ask ignored twice becomes a dashboard question, and the repo goes quiet', () => {
  const p = fresh();
  const n = emptyNudges();
  for (const repo of ['qr', 'facturar', 'ecom']) n.state.shrunk_ignored[repo] = CAPS.shrunkIgnoredLimit;
  n.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });
  n.history.push({ date: TUE, type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });

  const d = decide(p, n, WED);
  assert.equal(d.push, false, 'a question is surfaced, not pushed');
  assert.equal(d.type, 'question');
  applyDecision(p, n, d);

  assert.deepEqual(p.questions, [{ repo: 'qr', text: 'What is actually in the way on qr?', date: WED }]);
  assert.ok(n.state.muted.qr, 'the repo drops out of nudging');
  assert.equal(inCooldown(n, 'qr', THU), true);
  assert.equal(inCooldown(n, 'qr', '2026-09-05'), false, `mute lifts after ${CAPS.muteDays} days`);
});

test('a muted repo is skipped and the next batch is offered instead', () => {
  const p = fresh();
  const n = emptyNudges();
  for (const repo of ['qr', 'facturar', 'ecom']) n.state.muted[repo] = MON;

  const d = decide(p, n, TUE);
  assert.equal(d.push, true);
  assert.equal(d.type, 'db-session');
  assert.ok(!d.repos.includes('qr'), 'the muted batch is not re-offered');
});

test('no second nudge about a repo in the same week unless the owner interacted', () => {
  const n = emptyNudges();
  n.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'ignored', pushed: true });
  assert.equal(inCooldown(n, 'qr', WED), true, 'ignored — stays quiet');

  const acted = emptyNudges();
  acted.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'acted', pushed: true });
  assert.equal(inCooldown(acted, 'qr', WED), false, 'interaction clears the cooldown immediately');
});

/* --------------------------------------------------------------- ladder */

test('a booked session outranks the inbox but not a fresh DB batch', () => {
  const p = fresh();
  p.session = { booked: true, batch: 'qr,facturar,ecom', when: 'Thu 09:00' };
  assert.equal(decide(p, emptyNudges(), MON).type, 'db-session');

  // With every DB repo cleared, the booked reminder is what is left.
  for (const r of p.repos.filter((r) => r.blocker === 'db-setup')) clearBlocker(p, r.name, 'db-setup');
  const d = decide(p, emptyNudges(), MON);
  assert.equal(d.type, 'booked-reminder');
  assert.match(d.title, /Thu 09:00/);
  assert.doesNotMatch(d.body, /should have|behind|failed/i, 'confirmation, not guilt');
});

test('a completed session is not nagged about again', () => {
  const p = fresh();
  for (const r of p.repos.filter((r) => r.blocker === 'db-setup')) clearBlocker(p, r.name, 'db-setup');
  p.session = { booked: true, done: true, batch: 'qr' };
  const d = decide(p, emptyNudges(), MON);
  assert.notEqual(d.type, 'booked-reminder');
});

test('the day after a completed session is the one permitted repeat', () => {
  const p = fresh();
  p.session = { booked: true, done: true, done_date: MON, batch: 'qr,facturar,ecom' };
  const n = emptyNudges();
  n.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'acted', pushed: true });

  const d = decide(p, n, TUE);
  assert.equal(d.type, 'momentum');
  assert.equal(d.push, true);
  assert.match(d.title, /cleared/);
  assert.match(d.body, /minutes behind it/);

  assert.notEqual(decide(p, n, WED).type, 'momentum', 'it is one day only');
});

test('the inbox nudges in batches, never one item at a time', () => {
  const p = fresh();
  const n = emptyNudges();
  // Silence every other rung so the inbox is what the ladder reaches.
  for (const r of p.repos.filter((r) => r.blocker === 'db-setup')) clearBlocker(p, r.name, 'db-setup');

  p.decisions = Object.fromEntries(decisions.slice(0, decisions.length - 2).map((d) => [d.id, { accepted: true }]));
  assert.equal(decide(p, n, MON).push, false, 'two pending items is below the batch threshold');

  p.decisions = { D1: { accepted: true } };
  const d = decide(p, n, MON);
  assert.equal(d.type, 'quick-decisions');
  assert.match(d.body, /pre-filled/);
});

test('one stale decision trips the inbox on its own', () => {
  const p = fresh();
  for (const r of p.repos.filter((r) => r.blocker === 'db-setup')) clearBlocker(p, r.name, 'db-setup');
  p.decisions = Object.fromEntries(decisions.slice(1).map((d) => [d.id, { accepted: true }]));
  p.decisions_surfaced = MON;

  assert.equal(decide(p, n0(), TUE).push, false, 'one fresh item waits for company');
  assert.equal(decide(p, n0(), '2026-09-01').type, 'quick-decisions', 'after 7 days it goes on its own');
  function n0() { return emptyNudges(); }
});

test('a detected launch asks for verification, and only once', () => {
  const p = fresh();
  for (const r of p.repos.filter((r) => r.blocker === 'db-setup')) clearBlocker(p, r.name, 'db-setup');
  p.decisions = Object.fromEntries(decisions.map((d) => [d.id, { accepted: true }]));
  markLaunched(p, 'idioma', { date: MON });

  const d = decide(p, emptyNudges(), TUE);
  assert.equal(d.type, 'launch-verify');
  assert.match(d.title, /idioma is live/);

  p.repos.find((r) => r.name === 'idioma').launch_verified = true;
  assert.notEqual(decide(p, emptyNudges(), TUE).type, 'launch-verify');
});

test('nothing to say means no push at all', () => {
  const p = fresh();
  for (const r of p.repos.filter((r) => r.blocker === 'db-setup')) clearBlocker(p, r.name, 'db-setup');
  p.decisions = Object.fromEntries(decisions.map((d) => [d.id, { accepted: true }]));
  const d = decide(p, emptyNudges(), MON);
  assert.equal(d.push, false);
  assert.match(d.reason, /nothing on the ladder/);
});

/* ------------------------------------------------------------- outcomes */

test('outcomes resolve from what the harvest actually changed', () => {
  const n = emptyNudges();
  n.history.push({ date: MON, type: 'db-session', repos: ['qr', 'facturar'], outcome: 'pending', pushed: true });
  resolveOutcomes(n, { date: TUE, touched: ['facturar'] });
  assert.equal(n.history[0].outcome, 'acted');

  const m = emptyNudges();
  m.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'pending', pushed: true });
  resolveOutcomes(m, { date: TUE, touched: ['something-else'] });
  assert.equal(m.history[0].outcome, 'ignored');
});

test('an ignored shrunk ask counts toward the question threshold; acting resets it', () => {
  const n = emptyNudges();
  n.history.push({ date: MON, type: 'shrunk', repos: ['qr'], outcome: 'pending', pushed: true });
  resolveOutcomes(n, { date: TUE, touched: [] });
  assert.equal(n.state.shrunk_ignored.qr, 1);

  n.history.push({ date: TUE, type: 'shrunk', repos: ['qr'], outcome: 'pending', pushed: true });
  resolveOutcomes(n, { date: WED, touched: ['qr'] });
  assert.ok(!n.state.shrunk_ignored.qr, 'acting clears the count');
  assert.equal(n.state.muted.qr, undefined);
});

test('today\'s own pending record is never resolved by the same run', () => {
  const n = emptyNudges();
  n.history.push({ date: MON, type: 'db-session', repos: ['qr'], outcome: 'pending', pushed: true });
  resolveOutcomes(n, { date: MON, touched: [] });
  assert.equal(n.history[0].outcome, 'pending');
});

/* --------------------------------------------------- a fortnight, end to end */

test('over two weeks the caps hold: never twice a day, never six in a week, never a Sunday', () => {
  const p = fresh();
  const n = emptyNudges();
  const days = [];
  for (let i = 0; i < 14; i++) days.push(new Date(Date.parse(`${MON}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

  for (const day of days) {
    runDay(p, n, day);
    runDay(p, n, day); // a second run the same day must add nothing
  }

  const byDay = {};
  for (const h of n.history.filter((h) => h.pushed)) byDay[h.date] = (byDay[h.date] ?? 0) + 1;
  for (const [day, count] of Object.entries(byDay)) {
    assert.ok(count <= CAPS.maxPerDay, `${day} got ${count} pushes`);
    assert.notEqual(new Date(`${day}T12:00:00Z`).getUTCDay(), 0, `${day} is a Sunday`);
  }
  for (const week of new Set(Object.keys(byDay).map(weekKey))) {
    const count = Object.keys(byDay).filter((d) => weekKey(d) === week).length;
    assert.ok(count <= CAPS.maxPerWeek, `week of ${week} got ${count} pushes`);
  }

  // The same ask — same batch, whatever it is called — never lands three times
  // running, Sundays and capped days notwithstanding.
  // Same batch AND same form. Full ask → full ask → shrunk is the designed
  // escalation, not a repeat; three identical asks would be.
  const asks = n.history.filter((h) => h.pushed).map((h) => `${h.type}:${(h.repos ?? []).join('|')}`);
  for (let i = 2; i < asks.length; i++) {
    assert.ok(
      !(asks[i] === asks[i - 1] && asks[i] === asks[i - 2]),
      `the same ask (${asks[i]}) landed three times in a row`
    );
  }
});
