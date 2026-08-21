/**
 * harvest.js — read the owner's ticks back out of the live-doc.
 *
 * The live-doc's markup *is* the document: a checkbox the owner ticks on their
 * phone is saved into the page, so fetching the page and reading its inputs is
 * how the coach learns what happened. This module turns that HTML into
 * gestures, and gestures into portfolio state — in that order, so each half is
 * testable on its own.
 *
 * Rules that matter (DESIGN.md §1 caveat ii, §3 step 1):
 *  - The page is a projection. Nothing here trusts it as the source of truth;
 *    it only applies *positive* gestures found on it.
 *  - Unticking is never destructive. An unchecked box is silence, not a
 *    retraction — the drift guard (PR-5) surfaces contradictions for a human
 *    instead of silently reverting them.
 *  - Applying twice must be a no-op. The Routine re-runs daily against a page
 *    that still shows yesterday's ticks.
 *
 *   node src/harvest.js <fetched-page.html>          # show what it would change
 *   node src/harvest.js <fetched-page.html> --apply  # write portfolio.json
 */

import { readFileSync } from 'node:fs';
import { load, save, getRepo, clearBlocker, BLOCKERS } from './portfolio.js';

const INPUT = /<input\b[^>]*>/gi;
const ATTR = /([a-z][\w-]*)\s*=\s*"([^"]*)"/gi;

/** Parse one `<input …>` tag into a flat attribute bag. */
function attributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
  // Valueless boolean attributes never reach the loop above.
  if (/\bchecked\b(?!\s*=)/i.test(tag) || attrs.checked !== undefined) attrs.checked = 'true';
  if (/\bdisabled\b(?!\s*=)/i.test(tag)) attrs.disabled = 'true';
  return attrs;
}

/**
 * Every meaningful gesture on the page: ticked checkboxes and non-empty text
 * fields. Untouched controls are simply absent.
 */
export function parseGestures(html) {
  const gestures = [];
  for (const [tag] of html.matchAll(INPUT)) {
    const a = attributes(tag);
    if (!a['data-act']) continue;
    const type = (a.type ?? 'text').toLowerCase();

    if (type === 'checkbox') {
      if (a.checked !== 'true') continue;
      gestures.push({ act: a['data-act'], repo: a['data-repo'], blocker: a['data-blocker'], id: a['data-id'], choice: a['data-choice'], batch: a['data-batch'] });
    } else if (type === 'text') {
      const value = (a.value ?? '').trim();
      if (!value) continue;
      gestures.push({ act: a['data-act'], repo: a['data-repo'], id: a['data-id'], value });
    }
  }
  return gestures;
}

/**
 * Apply gestures to a portfolio. Returns the portfolio plus a human-readable
 * change list — the Routine commits with that list as the commit message.
 */
export function applyGestures(portfolio, gestures, { date = null } = {}) {
  const changes = [];
  portfolio.session = portfolio.session ?? {};
  portfolio.decisions = portfolio.decisions ?? {};
  const session = portfolio.session;

  const note = (msg) => changes.push(msg);

  for (const g of gestures) {
    switch (g.act) {
      case 'clear': {
        if (!g.repo || !BLOCKERS.includes(g.blocker)) break;
        let repo;
        try {
          repo = getRepo(portfolio, g.repo);
        } catch {
          break; // a repo that left the portfolio; the page is just stale
        }
        if (repo.blocker !== g.blocker) break; // already cleared — idempotent
        clearBlocker(portfolio, g.repo, g.blocker, { date });
        note(`${g.repo}: ${g.blocker} cleared`);
        break;
      }
      case 'booked':
        if (session.booked !== true) note(`session booked (${g.batch ?? 'current batch'})`);
        session.booked = true;
        session.batch = g.batch ?? session.batch ?? null;
        break;
      case 'when':
        if (session.when !== g.value) note(`session time: ${g.value}`);
        session.when = g.value;
        break;
      case 'done':
        if (session.done !== true) note(`session marked done (${g.batch ?? 'current batch'})`);
        session.done = true;
        session.done_date = date ?? session.done_date ?? null;
        break;
      case 'shrink':
        if (session.shrink !== true) note('session shrunk to the smallest step');
        session.shrink = true;
        session.batch_key = session.batch_key ?? null;
        break;
      case 'accept': {
        if (!g.id) break;
        const d = (portfolio.decisions[g.id] ??= {});
        if (d.accepted !== true) note(`${g.id} accepted`);
        d.accepted = true;
        d.date = date ?? d.date ?? null;
        break;
      }
      case 'note': {
        if (!g.id) break;
        const d = (portfolio.decisions[g.id] ??= {});
        if (d.note !== g.value) note(`${g.id} answered: ${g.value}`);
        d.note = g.value;
        break;
      }
      case 'classify': {
        if (!g.repo) break;
        let repo;
        try {
          repo = getRepo(portfolio, g.repo);
        } catch {
          break;
        }
        if (repo.blocker_note !== g.value) note(`${g.repo} classified: ${g.value}`);
        repo.blocker_note = g.value;
        break;
      }
      case 'scope': {
        if (!g.repo || !['keep', 'snooze', 'kill'].includes(g.choice)) break;
        let repo;
        try {
          repo = getRepo(portfolio, g.repo);
        } catch {
          break;
        }
        if (repo.scope_review !== g.choice) note(`${g.repo} scope review: ${g.choice}`);
        repo.scope_review = g.choice;
        repo.scope_review_date = date ?? null;
        break;
      }
      default:
        break; // an act this version does not know about is ignored, not fatal
    }
  }
  return { portfolio, changes };
}

/** Convenience: HTML in, updated portfolio + change list out. */
export function harvest(html, portfolio, opts = {}) {
  return applyGestures(portfolio, parseGestures(html), opts);
}

async function main(argv) {
  const [file, ...flags] = argv;
  if (!file) throw new Error('usage: node src/harvest.js <fetched-page.html> [--apply]');
  const { portfolio, changes } = harvest(readFileSync(file, 'utf8'), load(), {
    date: new Date().toISOString().slice(0, 10),
  });
  if (!changes.length) {
    console.log('no changes on the page');
    return;
  }
  console.log(changes.map((c) => `  · ${c}`).join('\n'));
  if (flags.includes('--apply')) {
    save(portfolio);
    console.log(`\napplied ${changes.length} change(s) to data/portfolio.json`);
  } else {
    console.log('\n(dry run — pass --apply to write)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
