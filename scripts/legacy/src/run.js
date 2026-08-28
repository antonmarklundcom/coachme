/**
 * run.js — one daily run, minus the two things a script cannot do.
 *
 * The Routine's session does the network parts (fetch the live-doc, publish it,
 * send the push). Everything between them is here, so the behaviour is
 * version-controlled and unit-testable instead of living in a prompt:
 *
 *   harvest → resolve outcomes → select → apply → save → render
 *
 *   node src/run.js --page fetched.html      # full run, writes state + dist/
 *   node src/run.js --page fetched.html --dry  # decide and print, write nothing
 *   node src/run.js --date 2026-08-25          # run as if it were that day
 *
 * It prints a JSON summary on stdout: whether to push, with what text, and what
 * changed. The Routine reads that and does the rest.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, load, save, NUDGES_PATH } from './portfolio.js';
import { harvest } from './harvest.js';
import { readMemory, adoptMemory } from './memory.js';
import { selectNudge, resolveOutcomes, applyDecision, isoDate } from './select.js';
import { applyScopeAnswers, wakeSnoozed } from './scope.js';
import { buildModel, renderDashboard, CONFIG_PATH, DECISIONS_PATH, DIST_DIR } from './render.js';

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/**
 * One run, as a pure function of its inputs. Returns the new state, the
 * rendered page and the summary; writing is the caller's business.
 */
export function runDaily({ portfolio, nudges, config, decisions, html = null, date = isoDate(Date.now()) }) {
  // 0. recover — the page carries the history it was rendered from. If the last
  // run could not write to the repo, this is where its record comes back, and
  // the caps below count days the coach really spoke rather than days it managed
  // to commit.
  const adopted = adoptMemory(nudges, readMemory(html));

  // 1. harvest — what did the owner do on the page since last time?
  const { changes } = html ? harvest(html, portfolio, { date }) : { changes: [] };
  const touched = changes.map((c) => c.split(':')[0].trim()).filter((name) => portfolio.repos.some((r) => r.name === name));

  // 2. settle anything the harvest answered, and wake repos whose snooze ran out
  const scopeChanges = applyScopeAnswers(portfolio, { date });
  const woken = wakeSnoozed(portfolio, { date });
  changes.push(...scopeChanges, ...woken.map((n) => `${n}: snooze expired`));

  // 3. resolve yesterday's pending nudges against what the owner did
  const resolved = resolveOutcomes(nudges, { date, touched, interacted: changes.length > 0 });

  // 4. select today's nudge and apply its effects
  const decision = selectNudge(portfolio, nudges, { date, decisions });
  applyDecision(portfolio, nudges, decision);

  // 5. render the page from the state we just settled
  const page = renderDashboard(buildModel(portfolio, { now: Date.parse(`${date}T12:00:00Z`), config, decisions, nudges }));

  return {
    portfolio,
    nudges,
    page,
    summary: {
      date,
      harvested: changes,
      adopted_from_page: adopted.map((r) => `${r.date} ${r.type}`),
      resolved: resolved.map((r) => `${r.date} ${r.type} → ${r.outcome}`),
      push: decision.push,
      type: decision.type,
      repos: decision.repos ?? [],
      title: decision.title ?? null,
      body: decision.body ?? null,
      reason: decision.reason,
      commit_needed: changes.length > 0 || adopted.length > 0 || !!decision.record,
    },
  };
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const dry = argv.includes('--dry');
  const pagePath = arg('--page');
  const date = arg('--date') ?? isoDate(Date.now());

  const result = runDaily({
    portfolio: load(),
    nudges: readJson(NUDGES_PATH, { history: [] }),
    config: readJson(CONFIG_PATH, {}),
    decisions: readJson(DECISIONS_PATH, { decisions: [] }).decisions,
    html: pagePath ? readFileSync(pagePath, 'utf8') : null,
    date,
  });

  if (!dry) {
    save(result.portfolio);
    writeFileSync(NUDGES_PATH, JSON.stringify(result.nudges, null, 2) + '\n');
    mkdirSync(DIST_DIR, { recursive: true });
    writeFileSync(join(DIST_DIR, 'dashboard.html'), result.page);
  }
  console.log(JSON.stringify(result.summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
