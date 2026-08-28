/**
 * nudge/history.ts — what the coach remembers, and what that memory forbids.
 *
 * A faithful port of the history half of scripts/legacy/src/select.js. The
 * legacy version kept a `state` blob alongside the history (`muted`,
 * `shrunk_ignored`); this one derives both from the history rows themselves, so
 * the audit trail and the state machine cannot disagree — there is only one copy.
 *
 * Pure: rows in, answers out. No database, no clock of its own.
 */

import { daysBetween, weekKey } from '../clock';

/** DESIGN.md §3, "Anti-annoyance rules (hard)". These are not tunables. */
export const CAPS = {
  maxPerDay: 1,
  maxPerWeek: 5,
  /** 0 = Sunday. Always silent. */
  silentWeekday: 0,
  /** The same ask may run at most this many consecutive times before it shrinks. */
  maxConsecutiveSame: 2,
  /** No second nudge about a repo inside this window unless the owner interacted. */
  repoCooldownDays: 7,
  /** After this many ignored shrunk asks, the coach asks a question instead. */
  shrunkIgnoredLimit: 2,
  /** How long a repo drops out of nudging once it reaches the question stage. */
  muteDays: 7,
  /** The inbox nudges only when it has this many items, or one this old. */
  inboxMinItems: 3,
  inboxMaxAgeDays: 7,
} as const;

export type NudgeType =
  | 'db-session'
  | 'booked-reminder'
  | 'quick-decisions'
  | 'scope-review'
  | 'launch-verify'
  | 'shrunk'
  | 'question'
  | 'momentum';

export type NudgeOutcome = 'pending' | 'acted' | 'ignored' | 'snoozed' | 'shrunk';

/** One row of `nudges`, oldest first as the callers below assume. */
export interface NudgeRecord {
  id: number;
  local_date: string;
  type: NudgeType;
  repo_names: string[];
  outcome: NudgeOutcome;
  pushed: boolean;
  shrunk: boolean;
  parent_type: string | null;
  title: string | null;
  body: string | null;
  note: string | null;
}

/** Pushes actually delivered on an owner-local date (`max 1 push/day`). */
export function pushesOn(history: NudgeRecord[], date: string): number {
  return history.filter((h) => h.local_date === date && h.pushed).length;
}

/**
 * Has the coach already decided today? A silence counts: surfacing a question
 * instead of pushing is still today's answer, and a re-fire must not be able to
 * turn it into a push. Cron retries and hand-fired runs both land here.
 */
export function decidedOn(history: NudgeRecord[], date: string): boolean {
  return history.some((h) => h.local_date === date);
}

export function pushesInWeek(history: NudgeRecord[], date: string): number {
  const week = weekKey(date);
  return history.filter((h) => weekKey(h.local_date) === week && h.pushed).length;
}

/**
 * How many times in a row the coach has already asked about THESE repos —
 * counting a full ask and its shrunk form as one chain, because to the owner
 * they are the same request getting quieter.
 *
 * Counted in nudges, not calendar days. A Sunday or a capped-out day is the
 * coach staying quiet, not the owner getting a break from the ask: counting days
 * would let a Sunday silently reset the chain and land the same request three
 * times running.
 *
 * Keyed on the repos, not the nudge type: pointing at a different batch is a
 * different ask, and shrinking an ask that was never made would be nonsense.
 */
export function chainLength(history: NudgeRecord[], repos: string[], date: string): number {
  let count = 0;
  // Walked backwards through insertion order, which is chronological — sorting
  // by date alone would shuffle two records written on the same day.
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.local_date >= date) continue;
    if (!(entry.repo_names ?? []).some((r) => repos.includes(r))) break;
    count++;
  }
  return count;
}

/** The most recent nudge mentioning this repo, if any. */
export function lastNudgeFor(history: NudgeRecord[], repo: string): NudgeRecord | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if ((history[i].repo_names ?? []).includes(repo)) return history[i];
  }
  return undefined;
}

/**
 * Muted: the repo reached the question stage and drops out of nudging for a week
 * (DESIGN.md §3). This is the only thing that makes the top batch rotate.
 *
 * Derived, not stored: the mute IS the `question` row. It lifts early if the
 * owner acted on it — answering the question is exactly the interaction the mute
 * was waiting for.
 */
export function isMuted(history: NudgeRecord[], repo: string, date: string): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.type !== 'question') continue;
    if (!(entry.repo_names ?? []).includes(repo)) continue;
    if (entry.outcome === 'acted') return false;
    return daysBetween(date, entry.local_date) < CAPS.muteDays;
  }
  return false;
}

/**
 * How many shrunk asks about this repo the owner has ignored in a row. Resets on
 * any nudge the owner acted on, which is what makes the escalation forgiving:
 * one real interaction and the coach starts over at a normal ask.
 */
export function shrunkIgnored(history: NudgeRecord[], repo: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!(entry.repo_names ?? []).includes(repo)) continue;
    if (entry.outcome === 'acted') break;
    if (entry.type === 'shrunk' && entry.outcome === 'ignored') count++;
  }
  return count;
}

/**
 * Cooldown: "never two nudges about the same repo in the same week unless you
 * interacted". This guards the *other* rungs — a scope review or a launch check
 * must not pile onto a repo the DB nudge is already working on. The DB rung's own
 * escalation chain (ask → shrink → question → mute) is what handles a repeat of
 * the same ask, so it deliberately does not consult this.
 */
export function inCooldown(history: NudgeRecord[], repo: string, date: string): boolean {
  if (isMuted(history, repo, date)) return true;
  const last = lastNudgeFor(history, repo);
  if (!last) return false;
  if (last.outcome === 'acted') return false;
  return daysBetween(date, last.local_date) < CAPS.repoCooldownDays;
}
