/**
 * render.js — portfolio → the live-doc dashboard (DESIGN.md §2).
 *
 * The dashboard is a projection of `data/portfolio.json`: every checkbox the
 * page serves is rendered *from* stored state, and `harvest.js` reads the
 * owner's ticks back into that state. The page is never the source of truth —
 * which is what makes a republish safe.
 *
 *   node src/render.js              # write dist/dashboard.html
 *   node src/render.js --stdout     # print it
 *
 * Publishing is a session action (the Artifact tool), not something this script
 * does — it has no network access by design.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, load, NUDGES_PATH } from './portfolio.js';
import { launchQueue, agentLane, dbBatches, rank } from './score.js';
import { momentum, isDormant, isKilled } from './scope.js';
import { render } from './template.js';
import { escapeHtml } from './template.js';
import { markdownToHtml } from './markdown.js';
import { RUNBOOKS_DIR } from './runbook.js';
import { embedMemory } from './memory.js';

export const CONFIG_PATH = join(ROOT, 'data', 'config.json');
export const DECISIONS_PATH = join(ROOT, 'data', 'decisions.json');
export const DIST_DIR = join(ROOT, 'dist');

const readJson = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

const DAY = 24 * 60 * 60 * 1000;

function humanDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function relativeDays(iso, now) {
  if (!iso) return null;
  const days = Math.floor((now - Date.parse(iso)) / DAY);
  if (Number.isNaN(days)) return null;
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}

/** The runbook, as HTML, for a repo that has one. */
function runbookHtml(name) {
  const path = join(RUNBOOKS_DIR, `${name}.md`);
  if (!existsSync(path)) return null;
  // The <h1> and the generator preamble are noise inside a collapsed card.
  const md = readFileSync(path, 'utf8').split('\n').slice(1).join('\n');
  return markdownToHtml(md, { headingOffset: 2 });
}

/**
 * The one prepped action (DESIGN.md §2.1). Normally the highest-leverage DB
 * batch; when the owner has ticked "not today", the shrunk version of it.
 */
export function todaysOneThing(portfolio, opts = {}) {
  const batches = dbBatches(portfolio, opts);
  if (!batches.length) return null;
  const batch = batches[0];
  const session = portfolio.session ?? {};
  const shrink = session.shrink === true && session.batch_key === batch.key;

  const repos = batch.entries.map((e) => ({
    name: e.repo.name,
    pct: e.repo.pct,
    tier: e.repo.tier,
    minutes: e.minutes,
    unblocks: e.unblocks.join(', '),
    has_unblocks: e.unblocks.length > 0,
    runbook: runbookHtml(e.repo.name),
    cleared: false,
  }));

  const shown = shrink ? repos.slice(0, 1) : repos;
  const headline = shrink
    ? `5 min: create the database and whitelist your IP for ${shown[0].name}`
    : `${batch.minutes} min unblocks ${repos.length} launch${repos.length === 1 ? '' : 'es'}: ${batch.repos.join(', ')}`;

  const pcts = repos.map((r) => r.pct);
  const why = shrink
    ? 'Smallest possible version of the same session. Do this much and the rest is a 15-minute follow-up.'
    : `${repos.length === 1 ? 'This repo is' : 'These are'} ${Math.min(...pcts)}–${Math.max(...pcts)}% finished code that ` +
      `nothing but an hPanel sitting stands in front of. Same panel for all of them, so the setup cost is paid once. ` +
      `It is the cheapest launch on the board.`;

  return {
    batch_key: batch.key,
    batch_repos: batch.repos.join(','),
    minutes: shrink ? 5 : batch.minutes,
    headline,
    why,
    repos: shown,
    shrink,
    booked: session.booked === true,
    booked_when: session.when ?? '',
    done: session.done === true,
  };
}

/** Everything the template interpolates. */
export function buildModel(portfolio, { now = Date.now(), config = {}, decisions = [], nudges = null } = {}) {
  const today = todaysOneThing(portfolio);
  const queue = launchQueue(portfolio);
  const scored = new Map(rank(portfolio).map((e) => [e.repo.name, e]));

  const asOf = humanDate(now);
  const strip = momentum(portfolio, nudges, { date: asOf, baselineMinutes: config.hpanel_baseline_minutes ?? null });

  const decisionState = portfolio.decisions ?? {};
  const unclassified = portfolio.repos.filter((r) => r.blocker === 'owner-setup-unclassified').filter((r) => !isDormant(r, asOf));

  return {
    generated: humanDate(now),
    // The page carries the nudge history it was rendered from, so the next run
    // can recover it when the previous run's commit never landed (memory.js).
    memory: embedMemory(nudges ?? { history: [] }),
    momentum: strip,
    today,
    has_today: !!today,
    queue: queue.map((e) => ({
      name: e.repo.name,
      pct: e.repo.pct,
      blocker: e.repo.blocker,
      minutes: e.minutes,
      score: e.total.toFixed(0),
      unblocks: e.unblocks.join(', '),
      has_unblocks: e.unblocks.length > 0,
      is_db: e.repo.blocker === 'db-setup',
      unclassified: e.repo.blocker === 'owner-setup-unclassified',
      next_step: e.repo.next_step ?? e.repo.blocker_note ?? '',
      newly_blocked: !!e.repo.newly_blocked,
      stuck: (e.repo.blocked_scans ?? 0) >= 3,
    })),
    queue_count: queue.length,
    queue_minutes: queue.reduce((s, e) => s + e.minutes, 0),
    decisions: decisions.map((d) => ({
      ...d,
      accepted: decisionState[d.id]?.accepted === true,
      note: decisionState[d.id]?.note ?? '',
      is_batch: d.batch === true,
    })),
    decisions_pending: decisions.filter((d) => decisionState[d.id]?.accepted !== true).length,
    classify: unclassified.map((r) => ({
      name: r.name,
      pct: r.pct,
      score: scored.get(r.name)?.total.toFixed(0) ?? '',
      note: r.blocker_note ?? '',
    })),
    classify_count: unclassified.length,
    // Drift: the scan and a human tick disagree. Never resolved silently —
    // the owner settles it (src/refresh.js).
    verify: portfolio.repos
      .filter((r) => r.drift_note)
      .map((r) => ({ name: r.name, note: r.drift_note, since: r.drift_date ?? '' })),
    verify_count: portfolio.repos.filter((r) => r.drift_note).length,
    agent: agentLane(portfolio)
      .filter((e) => e.repo.pct > 0)
      .slice(0, 12)
      .map((e) => ({
        name: e.repo.name,
        pct: e.repo.pct,
        lane: e.repo.lane.replace(/-/g, ' '),
        last: relativeDays(e.repo.last_commit, now) ?? 'not scanned yet',
        // Merged PRs are the honest evidence that the lane is actually moving —
        // a commit date can be a README typo, a merge is finished work.
        merged: e.repo.merged_prs ?? 0,
        has_merged: (e.repo.merged_prs ?? 0) > 0,
        open_prs: e.repo.open_prs ?? 0,
        has_open: (e.repo.open_prs ?? 0) > 0,
      })),
    scope: portfolio.repos
      .filter((r) => r.scope_review_due === true)
      .map((r) => ({
        name: r.name,
        pct: r.pct,
        choice: r.scope_review ?? '',
        proposed: r.scope_review_proposed ?? '',
        has_proposal: !!r.scope_review_proposed,
      })),
    scope_empty: !portfolio.repos.some((r) => r.scope_review_due === true),
    owner_minutes_total: strip.owner_minutes_total,
    dormant: portfolio.repos
      .filter((r) => isDormant(r, asOf))
      .map((r) => ({
        name: r.name,
        state: isKilled(r) ? 'killed' : `snoozed until ${r.snoozed_until}`,
      })),
    dormant_count: portfolio.repos.filter((r) => isDormant(r, asOf)).length,
  };
}

export function renderDashboard(model) {
  const template = readFileSync(join(ROOT, 'templates', 'dashboard.html'), 'utf8');
  return render(template, model, { escape: escapeHtml });
}

export function buildDashboard({ now = Date.now() } = {}) {
  const portfolio = load();
  const config = readJson(CONFIG_PATH, {});
  const { decisions } = readJson(DECISIONS_PATH, { decisions: [] });
  const nudges = readJson(NUDGES_PATH, { history: [] });
  return renderDashboard(buildModel(portfolio, { now, config, decisions, nudges }));
}

async function main(argv) {
  const html = buildDashboard();
  if (argv.includes('--stdout')) {
    process.stdout.write(html);
    return;
  }
  mkdirSync(DIST_DIR, { recursive: true });
  const out = join(DIST_DIR, 'dashboard.html');
  writeFileSync(out, html);
  console.log(`wrote dist/dashboard.html (${(html.length / 1024).toFixed(1)} kB)`);
  console.log('publish it with the Artifact tool, capabilities: { artifact: {} }');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
