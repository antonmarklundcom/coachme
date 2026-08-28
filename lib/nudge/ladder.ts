/**
 * nudge/ladder.ts — the priority ladder and the anti-annoyance state machine.
 *
 * A port of the decision half of scripts/legacy/src/select.js (DESIGN.md §3),
 * reading Neon rows instead of data/portfolio.json. It is deliberately the most
 * conservative module in the app: §3's caps are hard, and every one of them is a
 * unit test. A coach that nags gets muted, and a muted coach is worthless.
 *
 * Pure: no clock, no I/O, no side effects. lib/nudge/run.ts loads the state,
 * calls `selectNudge` once, then persists exactly what comes back.
 */

import { type Repo, isDormant } from '../domain';
import { daysBetween, weekdayOf } from '../clock';
import { dbBatches } from '../score';
import {
  CAPS,
  type NudgeRecord,
  type NudgeType,
  chainLength,
  decidedOn,
  inCooldown,
  isMuted,
  pushesInWeek,
  pushesOn,
  shrunkIgnored,
} from './history';

/** The `settings.session_state` blob — the old `portfolio.session` object. */
export interface SessionState {
  /** Comma-separated repo names, as the legacy field stored them. */
  batch?: string;
  booked?: boolean;
  when?: string;
  done?: boolean;
  done_date?: string;
  /** Set by the shrink rung; the dashboard renders the smaller ask. */
  shrink?: boolean;
  batch_key?: string | null;
}

export interface LadderDecision {
  push: boolean;
  type: NudgeType | null;
  repos: string[];
  /** Why this, in one line — logged, and stored on the row as `note`. */
  reason: string;
  title?: string;
  body?: string;
  minutes?: number;
  parentType?: NudgeType | null;
  shrunk?: boolean;
  /** State changes the caller must apply alongside the history row. */
  effects: { shrink?: { batch_key: string | null } };
}

export interface LadderInput {
  date: string;
  repos: Repo[];
  history: NudgeRecord[];
  session: SessionState;
  /** Unanswered rows of `decisions`, oldest `created_at` first. */
  pendingDecisions: { id: string; created_at: string }[];
  /** Open drift-guard items from `scan_events` — inbox items, not their own rung. */
  verifyItems: { repo_name: string | null; created_at: string }[];
}

interface Candidate {
  type: NudgeType;
  repos: string[];
  title: string;
  body: string;
  minutes?: number;
  batchKey?: string | null;
  /** The momentum push is the one repeat DESIGN.md §3 permits. */
  exemptFromRepeat?: boolean;
}

/* ------------------------------------------------------------------- rungs */

/** Rung 1: a prepped DB session is waiting. The whole point of the tool. */
function dbSessionCandidate(input: LadderInput): Candidate | null {
  const batches = dbBatches(input.repos, { date: input.date });
  // A batch every one of whose repos is muted has already been asked to death.
  const batch = batches.find((b) => !b.repos.every((r) => isMuted(input.history, r, input.date)));
  if (!batch) return null;
  const plural = batch.repos.length === 1 ? '' : 'es';
  return {
    type: 'db-session',
    repos: batch.repos,
    batchKey: batch.key,
    minutes: batch.minutes,
    title: `${batch.minutes} min unblocks ${batch.repos.length} launch${plural}`,
    body:
      `${batch.repos.join(', ')} — everything is prepped, the runbooks are on the dashboard, ` +
      `and it is copy-paste only. Same hPanel account for all of them.`,
  };
}

/**
 * Rung 2: a booked sitting the owner has not ticked done. Framed as
 * confirmation, not guilt (DESIGN.md §3). It sits below rung 1 on purpose — a
 * fresh, unbooked batch is the more urgent ask, and the legacy behaviour this
 * ports pins exactly that ordering.
 */
function bookedCandidate(input: LadderInput): Candidate | null {
  const session = input.session;
  if (session.booked !== true || session.done === true) return null;
  const repos = (session.batch ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    type: 'booked-reminder',
    repos,
    title: session.when ? `Your session is set for ${session.when}` : 'You booked a session',
    body: `${repos.join(', ') || 'The batch'} is prepped and waiting. Confirming, not chasing — tick Done when it is done.`,
  };
}

/**
 * Rung 3: the quick-decisions inbox, which nudges in a batch or not at all
 * (DESIGN.md §2.3: "never one-at-a-time drip"). An open drift-guard verify item
 * is an inbox item too — it is a one-line question only the owner can answer.
 */
function inboxCandidate(input: LadderInput): Candidate | null {
  const pending = input.pendingDecisions;
  const drifted = input.verifyItems;
  const items = pending.length + drifted.length;
  if (items === 0) return null;

  const oldest = [...pending, ...drifted]
    .map((i) => i.created_at.slice(0, 10))
    .sort()[0];
  const stale = oldest ? daysBetween(input.date, oldest) >= CAPS.inboxMaxAgeDays : false;
  if (items < CAPS.inboxMinItems && !stale) return null;

  const driftedNames = drifted.map((d) => d.repo_name).filter((n): n is string => !!n);
  const parts: string[] = [];
  if (pending.length) parts.push(pending.map((d) => d.id).join(', '));
  if (drifted.length) parts.push(`${drifted.length} to verify (${driftedNames.join(', ') || 'unnamed'})`);

  return {
    type: 'quick-decisions',
    repos: driftedNames,
    title: `${items} decisions, about three minutes`,
    body: `${parts.join('; ')} — the recommended answers are pre-filled. Scan, tick, correct at most one.`,
  };
}

/** Rung 4: the monthly scope review. The coach asks; the owner decides. */
function scopeCandidate(input: LadderInput): Candidate | null {
  const due = input.repos.filter(
    (r) =>
      r.scope_review_due === true &&
      !isDormant(r, input.date) &&
      !r.kept_at &&
      !inCooldown(input.history, r.name, input.date)
  );
  if (!due.length) return null;
  return {
    type: 'scope-review',
    repos: due.map((r) => r.name),
    title: `Scope review: ${due.length} repo${due.length === 1 ? '' : 's'} untouched`,
    body: 'Keep, snooze 90 days, or kill. Nothing is archived without your tick.',
  };
}

/** Rung 5: a launch the scan detected but the owner has not verified. */
function launchCandidate(input: LadderInput): Candidate | null {
  const launched = input.repos.filter(
    (r) =>
      !!r.launched_at &&
      daysBetween(input.date, r.launched_at) <= 1 &&
      daysBetween(input.date, r.launched_at) >= 0 &&
      r.live_url_ok !== true &&
      !isMuted(input.history, r.name, input.date)
  );
  if (!launched.length) return null;
  const names = launched.map((r) => r.name);
  return {
    type: 'launch-verify',
    repos: names,
    title: `${names.join(', ')} is live`,
    body: 'Open it, make one real record, and tick it off. Then the next one is right behind it.',
  };
}

/**
 * The momentum push (DESIGN.md §3): the day after a completed session, and the
 * one back-to-back repeat the rules deliberately permit. Evaluated first because
 * on that one day it is the right framing for whatever comes next.
 */
function momentumCandidate(input: LadderInput): Candidate | null {
  const session = input.session;
  if (session.done !== true || !session.done_date) return null;
  if (daysBetween(input.date, session.done_date) !== 1) return null;

  const done = (session.batch ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const next = dbBatches(input.repos, { date: input.date })[0];
  return {
    type: 'momentum',
    repos: next?.repos ?? [],
    exemptFromRepeat: true,
    title: done.length ? `${done.join(', ')} cleared` : 'Session cleared',
    body: next
      ? `${next.repos.join(', ')} is ${next.minutes} minutes behind it, in the same panel.`
      : 'That was the last DB sitting on the board.',
  };
}

/* ---------------------------------------------------------------- decision */

function silent(reason: string): LadderDecision {
  return { push: false, type: null, repos: [], reason, effects: {} };
}

/**
 * Decide what today's run does: a push, a silence, or a question. The caller
 * applies the result verbatim — this function chooses nothing twice and writes
 * nothing itself.
 */
export function selectNudge(input: LadderInput): LadderDecision {
  const { date, history } = input;

  // --- hard caps, before the ladder is even consulted. Never overridden.
  if (weekdayOf(date) === CAPS.silentWeekday) return silent('Sunday is always silent');
  // Two spellings of "once a day". The push cap is the rule DESIGN.md §3 states;
  // `decidedOn` is the stricter one that also makes a silent decision final, so a
  // cron retry cannot reconsider a question into a push. Both are stated so the
  // stated cap is directly testable rather than an emergent property.
  if (pushesOn(history, date) >= CAPS.maxPerDay) return silent(`daily cap of ${CAPS.maxPerDay} reached`);
  if (decidedOn(history, date)) return silent('already decided today');
  if (pushesInWeek(history, date) >= CAPS.maxPerWeek) {
    return silent(`weekly cap of ${CAPS.maxPerWeek} reached`);
  }

  // --- the ladder, first match wins (DESIGN.md §3).
  const candidate =
    momentumCandidate(input) ??
    dbSessionCandidate(input) ??
    bookedCandidate(input) ??
    inboxCandidate(input) ??
    scopeCandidate(input) ??
    launchCandidate(input);

  if (!candidate) return silent('nothing on the ladder qualifies');

  if (candidate.exemptFromRepeat) {
    return {
      push: true,
      type: candidate.type,
      repos: candidate.repos,
      title: candidate.title,
      body: candidate.body,
      reason: 'momentum push, the day after a completed session',
      effects: {},
    };
  }

  const runningFor = chainLength(history, candidate.repos, date);
  if (candidate.repos.length && runningFor >= CAPS.maxConsecutiveSame) {
    // Counted per repo, not per nudge type: a fresh batch starts a fresh
    // escalation and must not inherit the previous batch's exhausted patience.
    const ignored = Math.max(0, ...candidate.repos.map((r) => shrunkIgnored(history, r)));

    // Shrinking did not work twice — stop asking. Surface a question on the
    // dashboard instead and let the repo go quiet for a week. Writing this row
    // IS the mute: history.isMuted reads it back.
    if (ignored >= CAPS.shrunkIgnoredLimit) {
      const repo = candidate.repos[0];
      return {
        push: false,
        type: 'question',
        repos: candidate.repos,
        reason:
          `shrunk ask ignored ${ignored}x — asking a question on the dashboard instead, ` +
          `and muting for ${CAPS.muteDays} days`,
        title: `What is actually in the way on ${repo}?`,
        body: 'No push today. Answer it on the dashboard whenever — this repo goes quiet for a week.',
        parentType: candidate.type,
        effects: {},
      };
    }

    // Day three: the ask shrinks instead of repeating.
    const repo = candidate.repos[0];
    return {
      push: true,
      type: 'shrunk',
      repos: [repo],
      reason: `this ask has run ${runningFor} times — shrinking it`,
      title: `5 minutes: just create the database for ${repo}`,
      body: 'Create the DB and user, whitelist your IP. Stop there. The rest is a 15-minute follow-up whenever.',
      minutes: 5,
      parentType: candidate.type,
      shrunk: true,
      effects: { shrink: { batch_key: candidate.batchKey ?? null } },
    };
  }

  return {
    push: true,
    type: candidate.type,
    repos: candidate.repos,
    title: candidate.title,
    body: candidate.body,
    minutes: candidate.minutes,
    reason: `top of the ladder: ${candidate.type}`,
    effects: {},
  };
}
