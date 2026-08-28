/**
 * scope.js — the monthly scope review, and the momentum strip.
 *
 * Two halves of the same idea (DESIGN.md §1b): the 9 untouched repos are not a
 * separate problem, they are the avoidance mechanism. So the coach periodically
 * asks whether a project should exist — and, on the other side, shows visible
 * proof that finishing things is working.
 *
 * The asking is careful on purpose. The coach proposes; the owner decides;
 * nothing is archived on GitHub, ever (Decision D4's default). A "kill" here is
 * a flag in this repo and nothing more.
 */

import { isOwnerBlocked, ownerMinutes } from './portfolio.js';
import { dbBatches } from './score.js';
import { isoDate } from './select.js';

const DAY = 24 * 60 * 60 * 1000;
const asDate = (iso) => (iso ? Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso) : NaN);
const addDays = (iso, days) => isoDate(asDate(iso) + days * DAY);

/** A scope review runs at most this often. It is a monthly question, not a nag. */
export const REVIEW_INTERVAL_DAYS = 28;
export const SNOOZE_DAYS = 90;

/** Is a repo currently snoozed? */
export function isSnoozed(repo, date) {
  return !!repo.snoozed_until && asDate(repo.snoozed_until) > asDate(date);
}

/** Killed means flagged here. Nothing is archived on GitHub (Decision D4). */
export function isKilled(repo) {
  return !!repo.killed;
}

/** Repos that should be left alone entirely: killed, or sleeping. */
export function isDormant(repo, date = isoDate(Date.now())) {
  return isKilled(repo) || isSnoozed(repo, date);
}

/** Has enough time passed to ask the scope question again? */
export function reviewDue(portfolio, { date = isoDate(Date.now()) } = {}) {
  const last = portfolio.meta?.scope_review_last;
  if (!last) return true;
  return (asDate(date) - asDate(last)) / DAY >= REVIEW_INTERVAL_DAYS;
}

/**
 * Turn the owner's ticked keep / snooze / kill answers into state, and clear the
 * question. Called after harvest, before render.
 */
export function applyScopeAnswers(portfolio, { date = isoDate(Date.now()) } = {}) {
  const changes = [];

  for (const repo of portfolio.repos) {
    if (!repo.scope_review) continue;
    const answer = repo.scope_review;

    if (answer === 'snooze') {
      repo.snoozed_until = addDays(date, SNOOZE_DAYS);
      changes.push(`${repo.name}: snoozed until ${repo.snoozed_until}`);
    } else if (answer === 'kill') {
      repo.killed = date;
      changes.push(`${repo.name}: marked killed (a flag here — nothing archived on GitHub)`);
    } else if (answer === 'keep') {
      repo.kept = date;
      changes.push(`${repo.name}: kept`);
    }

    delete repo.scope_review;
    delete repo.scope_review_due;
    delete repo.scope_review_proposed;
    delete repo.scope_reviews_unanswered;
  }

  if (changes.length) portfolio.meta.scope_review_last = date;
  return changes;
}

/** A snooze that has run out puts the repo back in the pool. */
export function wakeSnoozed(portfolio, { date = isoDate(Date.now()) } = {}) {
  const woken = [];
  for (const repo of portfolio.repos) {
    if (repo.snoozed_until && !isSnoozed(repo, date)) {
      delete repo.snoozed_until;
      woken.push(repo.name);
    }
  }
  return woken;
}

/* ------------------------------------------------------------- momentum */

/**
 * The streak, defined honestly: **days since the coach last asked for something
 * and got nothing back.** A quiet day does not break it — silence is a feature,
 * and a streak that punished the coach for having nothing to say would be
 * measuring the wrong thing. An ignored ask does break it, because that is the
 * only failure mode the owner controls.
 */
export function streakDays(nudges, { date = isoDate(Date.now()) } = {}) {
  const history = (nudges?.history ?? []).filter((h) => h.date <= date);
  const lastIgnored = history.filter((h) => h.outcome === 'ignored').sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!lastIgnored) {
    const first = history.sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!first) return 0;
    return Math.max(0, Math.round((asDate(date) - asDate(first.date)) / DAY));
  }
  return Math.max(0, Math.round((asDate(date) - asDate(lastIgnored.date)) / DAY));
}

/** Everything the momentum strip needs (DESIGN.md §2.6). */
export function momentum(portfolio, nudges, { date = isoDate(Date.now()), baselineMinutes = null } = {}) {
  const remaining = dbBatches(portfolio).reduce((sum, b) => sum + b.minutes, 0);
  const baseline = baselineMinutes ?? remaining;

  const launches = portfolio.repos.filter(
    (r) => typeof r.launched === 'string' && (asDate(date) - asDate(r.launched)) / DAY <= 31
  );
  const sessions = (nudges?.history ?? []).filter((h) => h.type === 'db-session' && h.outcome === 'acted').length;

  return {
    launches: launches.length,
    launch_names: launches.map((r) => r.name),
    sessions,
    streak: streakDays(nudges, { date }),
    remaining_minutes: remaining,
    baseline_minutes: baseline,
    remaining_h: (remaining / 60).toFixed(1),
    baseline_h: (baseline / 60).toFixed(1),
    burned_pct: baseline > 0 ? Math.max(0, Math.min(100, Math.round(((baseline - remaining) / baseline) * 100))) : 0,
    owner_minutes_total: portfolio.repos
      .filter((r) => isOwnerBlocked(r) && !isDormant(r, date))
      .reduce((sum, r) => sum + ownerMinutes(r), 0),
  };
}
