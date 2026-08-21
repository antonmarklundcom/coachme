/**
 * portfolio.js — the state of record.
 *
 * Loads, validates, mutates and saves `data/portfolio.json`. Every other script
 * in this repo reads the portfolio through here so the shape is validated in
 * exactly one place. See DESIGN.md §5.
 *
 * No network, no side effects beyond the explicit save().
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const PORTFOLIO_PATH = join(ROOT, 'data', 'portfolio.json');
export const NUDGES_PATH = join(ROOT, 'data', 'nudges.json');

export const LANES = [
  'launch-owner-blocked',
  'launch-agent-drivable',
  'mid-agent-drivable',
  'mid-owner-stalled',
  'early-open',
  'early-owner-stalled',
];

export const BLOCKERS = [
  'db-setup',
  'credentials',
  'integration',
  'facts',
  'confirmation',
  'sibling',
  'none',
  'scope-undefined',
  'deferred',
  'owner-setup-unclassified',
];

export const TIERS = ['infra', 'revenue', 'experiment'];

/** Blockers whose owner is the owner, not an agent. */
export const OWNER_BLOCKERS = [
  'db-setup',
  'credentials',
  'integration',
  'facts',
  'confirmation',
  'scope-undefined',
  'owner-setup-unclassified',
];

/**
 * Estimated owner-minutes to clear each blocker category. Feeds the effort
 * penalty in score.js and the "45 min unblocks 3 launches" headline on the
 * dashboard. Deliberately coarse — these are planning numbers, not measurements.
 */
export const BLOCKER_MINUTES = {
  'db-setup': 20,
  credentials: 10,
  integration: 30,
  facts: 5,
  confirmation: 3,
  sibling: 0,
  none: 0,
  'scope-undefined': 15,
  // unclassified is priced pessimistically on purpose: it should lose to a known
  // 20-minute DB task until Decision D6 tells us what it actually is.
  'owner-setup-unclassified': 25,
};

export class ValidationError extends Error {}

function fail(msg) {
  throw new ValidationError(msg);
}

/** Validate a portfolio object in place; returns it, or throws ValidationError. */
export function validate(portfolio) {
  if (!portfolio || typeof portfolio !== 'object') fail('portfolio must be an object');
  if (!Array.isArray(portfolio.repos)) fail('portfolio.repos must be an array');

  const seen = new Set();
  for (const repo of portfolio.repos) {
    const at = `repo ${JSON.stringify(repo?.name ?? '<unnamed>')}`;
    if (!repo || typeof repo.name !== 'string' || !repo.name) fail(`${at}: name is required`);
    if (seen.has(repo.name)) fail(`${at}: duplicate name`);
    seen.add(repo.name);

    if (!Number.isFinite(repo.pct) || repo.pct < 0 || repo.pct > 100) {
      fail(`${at}: pct must be a number 0–100`);
    }
    if (!LANES.includes(repo.lane)) fail(`${at}: unknown lane ${JSON.stringify(repo.lane)}`);
    if (!BLOCKERS.includes(repo.blocker)) fail(`${at}: unknown blocker ${JSON.stringify(repo.blocker)}`);
    if (!TIERS.includes(repo.tier)) fail(`${at}: unknown tier ${JSON.stringify(repo.tier)}`);

    for (const key of ['unblocks', 'depends_on', 'related', 'cleared_blockers']) {
      if (repo[key] !== undefined && !Array.isArray(repo[key])) {
        fail(`${at}: ${key} must be an array when present`);
      }
    }
    if (repo.last_commit !== undefined && Number.isNaN(Date.parse(repo.last_commit))) {
      fail(`${at}: last_commit must be an ISO date string`);
    }
  }

  // Cross-references must point at repos we know about.
  for (const repo of portfolio.repos) {
    for (const key of ['unblocks', 'depends_on', 'related']) {
      for (const other of repo[key] ?? []) {
        if (!seen.has(other)) fail(`repo "${repo.name}": ${key} references unknown repo "${other}"`);
      }
    }
  }
  return portfolio;
}

export function load(path = PORTFOLIO_PATH) {
  return validate(JSON.parse(readFileSync(path, 'utf8')));
}

export function save(portfolio, path = PORTFOLIO_PATH) {
  validate(portfolio);
  writeFileSync(path, JSON.stringify(portfolio, null, 2) + '\n');
  return portfolio;
}

export function getRepo(portfolio, name) {
  const repo = portfolio.repos.find((r) => r.name === name);
  if (!repo) throw new ValidationError(`unknown repo "${name}"`);
  return repo;
}

/** True when clearing this repo's blocker is the owner's job, not an agent's. */
export function isOwnerBlocked(repo) {
  return OWNER_BLOCKERS.includes(repo.blocker);
}

export function ownerMinutes(repo) {
  return BLOCKER_MINUTES[repo.blocker] ?? 0;
}

/**
 * The lane a repo belongs in once its blocker is gone. Launch-stage repos become
 * agent-drivable (an agent can finish and ship them); mid/early repos just lose
 * their stall.
 */
function unblockedLane(lane) {
  switch (lane) {
    case 'launch-owner-blocked':
      return 'launch-agent-drivable';
    case 'mid-owner-stalled':
      return 'mid-agent-drivable';
    case 'early-owner-stalled':
      return 'early-open';
    default:
      return lane;
  }
}

/**
 * Clear a blocker — the transition a ticked "besikt DB done" box performs.
 * Records it in `cleared_blockers` (with the date) so the weekly drift guard in
 * PR-5 can tell a human tick apart from a stale audit, then moves the repo out
 * of its owner-stalled lane.
 */
export function clearBlocker(portfolio, name, blocker, { date = null } = {}) {
  const repo = getRepo(portfolio, name);
  if (!BLOCKERS.includes(blocker)) fail(`unknown blocker ${JSON.stringify(blocker)}`);
  if (repo.blocker !== blocker) {
    fail(`repo "${name}" is blocked on "${repo.blocker}", not "${blocker}"`);
  }
  repo.cleared_blockers = repo.cleared_blockers ?? [];
  repo.cleared_blockers.push(date ? { blocker, date } : { blocker });
  repo.blocker = 'none';
  repo.lane = unblockedLane(repo.lane);
  return repo;
}

/** Re-block a repo (drift guard / correction path). */
export function setBlocker(portfolio, name, blocker, { lane = null } = {}) {
  const repo = getRepo(portfolio, name);
  if (!BLOCKERS.includes(blocker)) fail(`unknown blocker ${JSON.stringify(blocker)}`);
  repo.blocker = blocker;
  if (lane) setLane(portfolio, name, lane);
  return repo;
}

export function setLane(portfolio, name, lane) {
  const repo = getRepo(portfolio, name);
  if (!LANES.includes(lane)) fail(`unknown lane ${JSON.stringify(lane)}`);
  repo.lane = lane;
  return repo;
}

/** Mark a repo launched: 100%, no blocker, agent-drivable launch lane. */
export function markLaunched(portfolio, name, { date = null } = {}) {
  const repo = getRepo(portfolio, name);
  repo.pct = 100;
  repo.blocker = 'none';
  repo.lane = 'launch-agent-drivable';
  repo.launched = date ?? true;
  return repo;
}

/**
 * Every repo blocked on `blocker` waiting on the owner. `sibling` repos are
 * excluded from owner queues by construction — they wait on another repo.
 */
export function ownerBlockedRepos(portfolio) {
  return portfolio.repos.filter(isOwnerBlocked);
}

export function dbBlockedRepos(portfolio) {
  return portfolio.repos.filter((r) => r.blocker === 'db-setup');
}

/** Reverse dependency edges: who does launching `name` unblock? */
export function unblockedBy(portfolio, name) {
  const direct = getRepo(portfolio, name).unblocks ?? [];
  const reverse = portfolio.repos
    .filter((r) => (r.depends_on ?? []).includes(name))
    .map((r) => r.name);
  return [...new Set([...direct, ...reverse])];
}
