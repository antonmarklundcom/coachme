import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, validate } from '../src/portfolio.js';
import { parseGestures, applyGestures, harvest } from '../src/harvest.js';
import { buildModel, renderDashboard, todaysOneThing, CONFIG_PATH, DECISIONS_PATH } from '../src/render.js';
import { readFileSync } from 'node:fs';

const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')).decisions;
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const fresh = () => load();
const dashboard = (p) => renderDashboard(buildModel(p, { config, decisions, now: Date.parse('2026-08-21') }));

/** Simulate a viewer ticking a checkbox: the live-doc saves `checked` into the markup. */
function tick(html, selectorAttrs) {
  const attrs = Object.entries(selectorAttrs).map(([k, v]) => `${k}="${v}"`);
  return html.replace(/<input\b[^>]*>/gi, (tag) => {
    if (!attrs.every((a) => tag.includes(a))) return tag;
    assert.ok(!tag.includes(' checked'), 'already ticked');
    return tag.replace(/>$/, ' checked>');
  });
}

/** Simulate typing into a text field. */
function type(html, selectorAttrs, value) {
  const attrs = Object.entries(selectorAttrs).map(([k, v]) => `${k}="${v}"`);
  return html.replace(/<input\b[^>]*>/gi, (tag) => {
    if (!attrs.every((a) => tag.includes(a))) return tag;
    return tag.replace(/value="[^"]*"/, `value="${value}"`);
  });
}

test('an untouched page yields no gestures and no changes', () => {
  const p = fresh();
  const { changes } = harvest(dashboard(p), p);
  assert.deepEqual(changes, []);
});

test('parseGestures ignores unchecked boxes and empty fields', () => {
  const html = `
    <input type="checkbox" data-act="clear" data-repo="qr" data-blocker="db-setup">
    <input type="checkbox" data-act="done" checked>
    <input type="text" data-act="when" value="">
    <input type="text" data-act="when" value=" Thursday 9am ">
    <input type="checkbox" value="x">`;
  assert.deepEqual(parseGestures(html), [
    { act: 'done', repo: undefined, blocker: undefined, id: undefined, choice: undefined, batch: undefined },
    { act: 'when', repo: undefined, id: undefined, value: 'Thursday 9am' },
  ]);
});

test('round trip: render → tick a blocker → harvest → the repo leaves the queue', () => {
  const p = fresh();
  let html = dashboard(p);
  assert.match(html, /data-act="clear" data-repo="qr" data-blocker="db-setup"/);

  html = tick(html, { 'data-act': 'clear', 'data-repo': 'qr' });
  const { portfolio, changes } = harvest(html, p, { date: '2026-08-21' });

  assert.deepEqual(changes, ['qr: db-setup cleared']);
  const qr = portfolio.repos.find((r) => r.name === 'qr');
  assert.equal(qr.blocker, 'none');
  assert.deepEqual(qr.cleared_blockers, [{ blocker: 'db-setup', date: '2026-08-21' }]);
  validate(portfolio);

  // and the next render no longer offers it
  assert.doesNotMatch(dashboard(portfolio), /data-act="clear" data-repo="qr"/);
});

test('round trip: booking a session persists the time and survives a re-render', () => {
  const p = fresh();
  let html = dashboard(p);
  html = tick(html, { 'data-act': 'booked' });
  html = type(html, { 'data-act': 'when' }, 'Thu 09:00');

  const { portfolio, changes } = harvest(html, p);
  assert.equal(portfolio.session.booked, true);
  assert.equal(portfolio.session.when, 'Thu 09:00');
  assert.equal(changes.length, 2);

  const again = dashboard(portfolio);
  assert.match(again, /data-act="booked"[^>]*checked/);
  assert.match(again, /data-act="when"[^>]*value="Thu 09:00"/);
});

test('harvesting the same page twice changes nothing the second time', () => {
  const p = fresh();
  let html = dashboard(p);
  html = tick(html, { 'data-act': 'clear', 'data-repo': 'besikt' });
  html = tick(html, { 'data-act': 'booked' });
  html = type(html, { 'data-act': 'when' }, 'Saturday');

  const first = harvest(html, p);
  assert.equal(first.changes.length, 3);
  const second = harvest(html, first.portfolio);
  assert.deepEqual(second.changes, [], 'a second harvest of the same page must be a no-op');
});

test('an unticked box never retracts state that is already recorded', () => {
  const p = fresh();
  const ticked = tick(dashboard(p), { 'data-act': 'booked' });
  const { portfolio } = harvest(ticked, p);
  assert.equal(portfolio.session.booked, true);

  // The next render shows it checked; pretend the fetch came back with it clear.
  const cleared = dashboard(portfolio).replace(/(data-act="booked"[^>]*) checked/, '$1');
  const after = harvest(cleared, portfolio);
  assert.equal(after.portfolio.session.booked, true, 'silence is not a retraction');
  assert.deepEqual(after.changes, []);
});

test('decisions and D6 classifications round-trip', () => {
  const p = fresh();
  let html = dashboard(p);
  html = tick(html, { 'data-act': 'accept', 'data-id': 'D3' });
  html = type(html, { 'data-act': 'note', 'data-id': 'D1' }, '07:30 Europe/Stockholm');
  html = type(html, { 'data-act': 'classify', 'data-repo': 'gruas' }, 'point the domain at the app');

  const { portfolio, changes } = harvest(html, p);
  assert.equal(portfolio.decisions.D3.accepted, true);
  assert.equal(portfolio.decisions.D1.note, '07:30 Europe/Stockholm');
  assert.equal(portfolio.repos.find((r) => r.name === 'gruas').blocker_note, 'point the domain at the app');
  assert.equal(changes.length, 3);

  const again = dashboard(portfolio);
  assert.match(again, /data-act="accept" data-id="D3"[^>]*checked/);
  assert.match(again, /data-id="D1"[^>]*value="07:30 Europe\/Stockholm"/);
  assert.match(again, /data-repo="gruas"[^>]*value="point the domain at the app"/);
});

test('gestures for repos or blockers that no longer match are ignored, not fatal', () => {
  const p = fresh();
  const html = `
    <input type="checkbox" data-act="clear" data-repo="ghost" data-blocker="db-setup" checked>
    <input type="checkbox" data-act="clear" data-repo="qr" data-blocker="credentials" checked>
    <input type="checkbox" data-act="unknown-future-act" checked>
    <input type="checkbox" data-act="scope" data-repo="qr" data-choice="explode" checked>`;
  const { portfolio, changes } = harvest(html, p);
  assert.deepEqual(changes, []);
  assert.equal(portfolio.repos.find((r) => r.name === 'qr').blocker, 'db-setup');
  validate(portfolio);
});

test('shrinking swaps today\'s card for its smallest sub-step', () => {
  const p = fresh();
  const full = todaysOneThing(p);
  assert.equal(full.repos.length, 3);

  const { portfolio } = harvest(tick(dashboard(p), { 'data-act': 'shrink' }), p);
  portfolio.session.batch_key = full.batch_key; // the Routine records which batch was shrunk
  const small = todaysOneThing(portfolio);
  assert.equal(small.repos.length, 1);
  assert.equal(small.minutes, 5);
  assert.match(small.headline, /^5 min: create the database/);
});

test('scope-review answers are recorded per repo', () => {
  const p = fresh();
  p.repos.find((r) => r.name === 'anillos').scope_review_due = true;
  const html = tick(dashboard(p), { 'data-act': 'scope', 'data-repo': 'anillos', 'data-choice': 'snooze' });
  const { portfolio, changes } = harvest(html, p, { date: '2026-08-21' });
  assert.equal(portfolio.repos.find((r) => r.name === 'anillos').scope_review, 'snooze');
  assert.deepEqual(changes, ['anillos scope review: snooze']);
});
