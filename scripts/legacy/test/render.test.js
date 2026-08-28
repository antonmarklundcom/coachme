import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from '../src/portfolio.js';
import { buildModel, renderDashboard, buildDashboard, todaysOneThing, DECISIONS_PATH, CONFIG_PATH } from '../src/render.js';
import { assertNoSecrets } from '../src/runbook.js';
import { markdownToHtml } from '../src/markdown.js';
import { readMemory, adoptMemory } from '../src/memory.js';

const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')).decisions;
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const html = buildDashboard({ now: Date.parse('2026-08-21') });

test('the page renders every section of DESIGN §2, in order', () => {
  const order = ["Today's one thing", 'Launch queue', 'Quick decisions', 'Agent lane', 'Scope review'];
  let at = -1;
  for (const heading of order) {
    const next = html.indexOf(heading);
    assert.ok(next > at, `${heading} missing or out of order`);
    at = next;
  }
  assert.match(html, /hPanel time left/, 'momentum strip missing');
});

test('no template tags survive, and the page is content only (the shell adds head/body)', () => {
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /<!doctype|<html|<body|<head>/i);
  assert.match(html, /^<title>Final Mile<\/title>/);
});

test('the page runs no script — every gesture persists through markup alone', () => {
  // The one <script> allowed is the inert application/json memory block: the
  // browser never executes it, and the coach reads it back when a run could not
  // write to the repo (memory.js).
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script type="application/json" id="coach-memory">']);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
});

test('the page carries the history it was rendered from, and a later run adopts it', () => {
  const spoken = { history: [{ date: '2026-08-19', type: 'db-session', repos: ['qr'], outcome: 'pending' }] };
  const page = renderDashboard(buildModel(load(), { config, decisions, nudges: spoken }));
  assert.deepEqual(readMemory(page), spoken.history, 'the block survives rendering');

  const forgotten = { history: [] }; // a repo whose last commit never landed
  const adopted = adoptMemory(forgotten, readMemory(page));
  assert.equal(adopted.length, 1);
  assert.deepEqual(forgotten.history, spoken.history);
  assert.deepEqual(adoptMemory(forgotten, readMemory(page)), [], 'adopting twice is a no-op');
});

test('adopting never drops what the repo already knows', () => {
  const local = { history: [{ date: '2026-08-20', type: 'quick-decisions', repos: [] }] };
  const page = renderDashboard(buildModel(load(), { config, decisions, nudges: { history: [{ date: '2026-08-19', type: 'db-session', repos: ['qr'] }] } }));
  adoptMemory(local, readMemory(page));
  assert.deepEqual(local.history.map((r) => r.date), ['2026-08-19', '2026-08-20'], 'union, in date order');
});

test('a page with no memory block, or a mangled one, changes nothing', () => {
  const local = { history: [{ date: '2026-08-20', type: 'db-session', repos: [] }] };
  assert.deepEqual(adoptMemory(local, readMemory('<p>not the dashboard</p>')), []);
  assert.deepEqual(adoptMemory(local, readMemory('<script type="application/json" id="coach-memory">{oh no</script>')), []);
  assert.equal(local.history.length, 1);
});

test('both themes are defined at token level, never only inside a media query', () => {
  const tokens = ['--ground', '--surface', '--ink', '--line', '--accent'];
  const base = html.slice(html.indexOf(':root {'), html.indexOf('@media (prefers-color-scheme: dark)'));
  for (const t of tokens) assert.ok(base.includes(t), `${t} has no light-theme definition on bare :root`);
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/, 'dark media query must not beat an explicit light choice');
  assert.match(html, /:root\[data-theme="dark"\]/, 'explicit dark stamp must win too');
  assert.match(html, /body\s*\{[^}]*background:\s*var\(--ground\)/, 'body needs an explicit token background');
});

test('every interactive control is addressable by the harvester', () => {
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    assert.match(tag, /data-act="/, `input without data-act: ${tag}`);
    if (/data-act="(clear|classify)"/.test(tag)) assert.match(tag, /data-repo="/, tag);
    if (/data-act="(accept|note)"/.test(tag)) assert.match(tag, /data-id="/, tag);
    if (/data-act="scope"/.test(tag)) assert.match(tag, /data-choice="(keep|snooze|kill)"/, tag);
  }
});

test('today\'s card is the top DB batch, with its runbooks inline', () => {
  const portfolio = load();
  const today = todaysOneThing(portfolio);
  assert.deepEqual(today.repos.map((r) => r.name), ['qr', 'facturar', 'ecom']);
  assert.equal(today.minutes, 45);
  assert.match(html, /45 min unblocks 3 launches: qr, facturar, ecom/);
  for (const repo of today.repos) assert.ok(repo.runbook?.includes('<pre>'), `${repo.name} runbook not inlined`);
  assert.match(html, /Remote MySQL/, 'the runbook steps must actually be on the page');
});

test('the dashboard never carries a credential', () => {
  assert.doesNotThrow(() => assertNoSecrets(html, 'dashboard'));
});

test('the launch queue on the page matches the scored queue exactly', () => {
  const model = buildModel(load(), { config, decisions, now: Date.parse('2026-08-21') });
  assert.equal(model.queue.length, 20);
  for (const row of model.queue) {
    assert.match(html, new RegExp(`data-act="clear" data-repo="${row.name.replace('.', '\\.')}"`));
  }
});

test('the burn-down bar measures against the recorded baseline', () => {
  const model = buildModel(load(), { config, decisions });
  assert.equal(model.momentum.baseline_h, '3.3');
  assert.equal(model.momentum.burned_pct, 0, 'nothing cleared yet');

  const cleared = load();
  cleared.repos.filter((r) => ['qr', 'facturar', 'ecom'].includes(r.name)).forEach((r) => (r.blocker = 'none'));
  const after = buildModel(cleared, { config, decisions });
  assert.ok(after.momentum.burned_pct > 0, 'clearing a whole sitting must move the bar');
  assert.ok(Number(after.momentum.remaining_h) < Number(model.momentum.remaining_h));
});

test('an empty scope review says so instead of rendering an empty list', () => {
  assert.match(html, /Nothing due\./);
});

test('markdown subset: the constructs the runbooks actually use', () => {
  assert.equal(markdownToHtml('## A'), '<h2>A</h2>');
  assert.equal(markdownToHtml('## A', { headingOffset: 2 }), '<h4>A</h4>');
  assert.equal(markdownToHtml('```\na<b\n```'), '<pre><code>a&lt;b</code></pre>');
  assert.equal(markdownToHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(markdownToHtml('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.match(markdownToHtml('> quoted'), /^<blockquote>/);
  assert.match(markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th>/);
  assert.equal(markdownToHtml('use `x` and **y**'), '<p>use <code>x</code> and <strong>y</strong></p>');
});

test('an indented continuation line does not split a numbered list', () => {
  const md = '1. one\n2. **Password:** save it as\n   *"repo — Hostinger"*. done.\n3. three';
  const out = markdownToHtml(md);
  assert.equal((out.match(/<ol>/g) ?? []).length, 1, 'the list must not restart');
  assert.equal((out.match(/<li>/g) ?? []).length, 3);
  assert.match(out, /<em>&quot;repo — Hostinger&quot;<\/em>/);
});

test('markdown escapes before it formats — no raw HTML gets through', () => {
  assert.doesNotMatch(markdownToHtml('<img src=x onerror=alert(1)>'), /<img/);
  assert.doesNotMatch(markdownToHtml('`<script>`'), /<script/);
});

test('the rendered page stays small enough to publish comfortably', () => {
  assert.ok(html.length < 400_000, `dashboard is ${html.length} bytes`);
});

test('renderDashboard is pure — same state in, same page out', () => {
  const model = buildModel(load(), { config, decisions, now: Date.parse('2026-08-21') });
  assert.equal(renderDashboard(model), renderDashboard(model));
});
