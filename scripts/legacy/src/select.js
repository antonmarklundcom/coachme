/**
 * select.js — the priority ladder and the anti-annoyance state machine.
 *
 * This is the part of the coach that decides whether today earns a push
 * notification, and it is deliberately the most conservative module in the
 * repo: DESIGN.md §3's caps are hard, and every one of them is a unit test.
 * A coach that nags gets muted, and a muted coach is worthless.
 *
 * Pure: no clock of its own beyond what is passed in, no I/O, no side effects.
 * The Routine applies `effects` and appends `record`; this module only decides.
 *
 *   node src/select.js            # what would today's run do?
 *   node src/select.js 2026-08-24 # ...on a given local date
 */

import { load, NUDGES_PATH, getRepo } from './portfolio.js';
import { dbBatches, launchQueue } from './score.js';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

/** DESIGN.md §3, "Anti-annoyance rules (hard)". */
export const CAPS = {
  maxPerDay: 1,
  maxPerWeek: 5,
  /** 0 = Sunday. Always silent. */
  silentWeekday: 0,
  /** The same nudge may run at most this many consecutive days before it shrinks. */
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
};

const DAY = 24 * 60 * 60 * 1000;
const asDate = (iso) => Date.parse(`${iso}T12:00:00Z`);
export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekdayOf = (iso) => new Date(asDate(iso)).getUTCDay();
const daysBetween = (a, b) => Math.round((asDate(a) - asDate(b)) / DAY);

/** Monday-anchored week key, so "5 per week" means something stable. */
export function weekKey(iso) {
  const d = new Date(asDate(iso));
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  return isoDate(monday.getTime());
}

const historyOf = (nudges) => nudges?.history ?? [];
const stateOf = (nudges) => (nudges.state ??= { muted: {}, shrunk_ignored: {} });

/* --------------------------------------------------------------- history */

/** Pushes already sent on a given local date. */
export function pushesOn(nudges, date) {
  return historyOf(nudges).filter((h) => h.date === date && h.pushed !== false).length;
}

/**
 * Has the coach already decided today? A silent decision counts: surfacing a
 * question instead of pushing is still today's answer, and a second run must
 * not turn it into a push. (The Routine fires once a day, but a manual re-fire
 * or a retry must be harmless.)
 */
export function decidedOn(nudges, date) {
  return historyOf(nudges).some((h) => h.date === date);
}

export function pushesInWeek(nudges, date) {
  const week = weekKey(date);
  return historyOf(nudges).filter((h) => weekKey(h.date) === week && h.pushed !== false).length;
}

/**
 * How many times in a row the coach has already asked about THIS batch —
 * counting the full ask and its shrunk form as one chain, because to the owner
 * they are the same request getting quieter.
 *
 * Counted in nudges, not calendar days. A Sunday or a capped-out day is the
 * coach staying quiet, not the owner getting a break from the ask: if the days
 * were counted instead, a Sunday would silently reset the chain and the same
 * request would land three times running.
 *
 * Keyed on the repos, not the nudge type: pointing at a different batch is a
 * different ask, and shrinking an ask that was never made would be nonsense.
 */
export function chainLength(nudges, repos, date) {
  // Walked backwards through insertion order, which is chronological — sorting
  // by date alone would shuffle two records written on the same day.
  const history = historyOf(nudges);
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.date >= date) continue;
    if (!(entry.repos ?? []).some((r) => repos.includes(r))) break;
    count++;
  }
  return count;
}

/** The last nudge that mentioned this repo, if any. */
export function lastNudgeFor(nudges, repo) {
  return historyOf(nudges)
    .filter((h) => (h.repos ?? []).includes(repo))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

/**
 * Muted: the repo reached the question stage and drops out of nudging for a
 * week (DESIGN.md §3). This is the only thing that makes the top batch rotate.
 */
export function isMuted(nudges, repo, date) {
  const muted = stateOf(nudges).muted?.[repo];
  return !!muted && daysBetween(date, muted) < CAPS.muteDays;
}

/**
 * Cooldown: "never two nudges about the same repo in the same week unless you
 * interacted". This guards the *other* rungs — a scope review or a launch
 * check must not pile onto a repo the DB nudge is already working on. The DB
 * rung's own escalation chain (ask → shrink → question → mute) is what handles
 * a repeat of the same ask, so it deliberately does not consult this.
 */
export function inCooldown(nudges, repo, date) {
  if (isMuted(nudges, repo, date)) return true;
  const last = lastNudgeFor(nudges, repo);
  if (!last) return false;
  if (last.outcome === 'acted') return false;
  return daysBetween(date, last.date) < CAPS.repoCooldownDays;
}

/* ---------------------------------------------------------------- ladder */

function dbSessionCandidate(portfolio, nudges, date) {
  const batches = dbBatches(portfolio);
  if (!batches.length) return null;
  const batch = batches.find((b) => !b.repos.every((r) => isMuted(nudges, r, date)));
  if (!batch) return null;
  return {
    type: 'db-session',
    repos: batch.repos,
    batch_key: batch.key,
    minutes: batch.minutes,
    title: `${batch.minutes} min unblocks ${batch.repos.length} launch${batch.repos.length === 1 ? '' : 'es'}`,
    body:
      `${batch.repos.join(', ')} — everything is prepped, the runbooks are on the dashboard, ` +
      `and it is copy-paste only. Same hPanel account for all of them.`,
  };
}

function bookedCandidate(portfolio, date) {
  const session = portfolio.session ?? {};
  if (session.booked !== true || session.done === true) return null;
  const repos = (session.batch ?? '').split(',').filter(Boolean);
  return {
    type: 'booked-reminder',
    repos,
    title: session.when ? `Your session is set for ${session.when}` : 'You booked a session',
    body: `${repos.join(', ') || 'The batch'} is prepped and waiting. Confirming, not chasing — tick Done when it is done.`,
  };
}

function inboxCandidate(portfolio, decisions, date) {
  const answered = portfolio.decisions ?? {};
  const pending = decisions.filter((d) => answered[d.id]?.accepted !== true && !answered[d.id]?.note);
  // A scan-vs-tick disagreement is an inbox item too: it is a one-line question
  // only the owner can answer, and it batches with the rest rather than
  // interrupting on its own.
  const drifted = portfolio.repos.filter((r) => r.drift_note);
  if (!pending.length && !drifted.length) return null;

  const oldest = portfolio.decisions_surfaced ?? null;
  const stale = oldest ? daysBetween(date, oldest) >= CAPS.inboxMaxAgeDays : false;
  const items = pending.length + drifted.length;
  if (items < CAPS.inboxMinItems && !stale) return null;

  const parts = [];
  if (pending.length) parts.push(pending.map((d) => d.id).join(', '));
  if (drifted.length) parts.push(`${drifted.length} to verify (${drifted.map((r) => r.name).join(', ')})`);

  return {
    type: 'quick-decisions',
    repos: drifted.map((r) => r.name),
    title: `${items} decisions, about three minutes`,
    body: `${parts.join('; ')} — the recommended answers are pre-filled. Scan, tick, correct at most one.`,
  };
}

function scopeCandidate(portfolio, nudges, date) {
  const due = portfolio.repos.filter(
    (r) => r.scope_review_due === true && !r.scope_review && !inCooldown(nudges, r.name, date)
  );
  if (!due.length) return null;
  return {
    type: 'scope-review',
    repos: due.map((r) => r.name),
    title: `Scope review: ${due.length} repo${due.length === 1 ? '' : 's'} untouched`,
    body: 'Keep, snooze 90 days, or kill. Nothing is archived without your tick.',
  };
}

function launchCandidate(portfolio, nudges, date) {
  const launched = portfolio.repos.filter(
    (r) =>
      typeof r.launched === 'string' &&
      daysBetween(date, r.launched) <= 1 &&
      !r.launch_verified &&
      !isMuted(nudges, r.name, date)
  );
  if (!launched.length) return null;
  return {
    type: 'launch-verify',
    repos: launched.map((r) => r.name),
    title: `${launched.map((r) => r.name).join(', ')} is live`,
    body: 'Open it, make one real record, and tick it off. Then the next one is right behind it.',
  };
}

/**
 * The momentum push (DESIGN.md §3): the day after a completed session, and the
 * one repeat the rules deliberately permit.
 */
function momentumCandidate(portfolio, nudges, date) {
  const session = portfolio.session ?? {};
  if (session.done !== true || !session.done_date) return null;
  if (daysBetween(date, session.done_date) !== 1) return null;

  const done = (session.batch ?? '').split(',').filter(Boolean);
  const next = dbBatches(portfolio)[0];
  return {
    type: 'momentum',
    repos: next?.repos ?? [],
    exempt_from_repeat: true,
    title: done.length ? `${done.join(', ')} cleared` : 'Session cleared',
    body: next
      ? `${next.repos.join(', ')} is ${next.minutes} minutes behind it, in the same panel.`
      : 'That was the last DB sitting on the board.',
  };
}

/* -------------------------------------------------------------- decision */

const silent = (reason) => ({ push: false, type: null, repos: [], reason, effects: {}, record: null });

/**
 * Decide what today's run does. Returns a decision the Routine can apply
 * verbatim: a push or a silence, the state changes it implies, and the history
 * record to append.
 */
export function selectNudge(portfolio, nudges, { date = isoDate(Date.now()), decisions = [] } = {}) {
  // --- hard caps, before anything else. These are never overridden.
  if (weekdayOf(date) === CAPS.silentWeekday) return silent('Sunday is always silent');
  if (decidedOn(nudges, date)) return silent('already decided today');
  if (pushesInWeek(nudges, date) >= CAPS.maxPerWeek) return silent(`weekly cap of ${CAPS.maxPerWeek} reached`);

  // --- the ladder, first match wins (DESIGN.md §3).
  const candidate =
    momentumCandidate(portfolio, nudges, date) ??
    dbSessionCandidate(portfolio, nudges, date) ??
    bookedCandidate(portfolio, date) ??
    inboxCandidate(portfolio, decisions, date) ??
    scopeCandidate(portfolio, nudges, date) ??
    launchCandidate(portfolio, nudges, date);

  if (!candidate) return silent('nothing on the ladder qualifies');

  // --- anti-annoyance. The momentum push is the one permitted repeat.
  if (candidate.exempt_from_repeat) {
    return {
      push: true,
      ...candidate,
      reason: 'momentum push, the day after a completed session',
      effects: {},
      record: { date, type: candidate.type, repos: candidate.repos, outcome: 'pending', pushed: true },
    };
  }

  const runningFor = chainLength(nudges, candidate.repos ?? [], date);

  if (candidate.repos?.length && runningFor >= CAPS.maxConsecutiveSame) {
    // Counted per repo, not per nudge type: a fresh batch starts a fresh
    // escalation, and must not inherit the previous batch's exhausted patience.
    const counts = stateOf(nudges).shrunk_ignored ?? {};
    const ignored = Math.max(0, ...candidate.repos.map((r) => counts[r] ?? 0));

    // Shrinking did not work twice — stop asking, ask a question instead, and
    // let the repo go quiet for a week.
    if (ignored >= CAPS.shrunkIgnoredLimit) {
      const repo = candidate.repos[0];
      return {
        push: false,
        type: 'question',
        repos: candidate.repos,
        reason: `shrunk ask ignored ${ignored}x — asking a question on the dashboard instead, and muting for ${CAPS.muteDays} days`,
        effects: {
          question: repo ? { repo, text: `What is actually in the way on ${repo}?`, date } : null,
          mute: candidate.repos,
        },
        record: { date, type: 'question', repos: candidate.repos, outcome: 'pending', pushed: false },
      };
    }

    // Day three: the ask shrinks instead of repeating.
    const repo = candidate.repos[0];
    return {
      push: true,
      type: 'shrunk',
      repos: repo ? [repo] : [],
      reason: `this ask has run ${runningFor} times — shrinking it`,
      title: repo ? `5 minutes: just create the database for ${repo}` : 'A smaller version of yesterday',
      body: repo
        ? `Create the DB and user, whitelist your IP. Stop there. The rest is a 15-minute follow-up whenever.`
        : 'The smallest possible version of yesterday\'s ask.',
      minutes: 5,
      effects: { shrink: { batch_key: candidate.batch_key ?? null } },
      record: { date, type: 'shrunk', repos: repo ? [repo] : [], parent_type: candidate.type, outcome: 'pending', pushed: true },
    };
  }

  return {
    push: true,
    ...candidate,
    reason: `top of the ladder: ${candidate.type}`,
    effects: {},
    record: { date, type: candidate.type, repos: candidate.repos, outcome: 'pending', pushed: true },
  };
}

/* ------------------------------------------------------------- outcomes */

/**
 * Resolve yesterday's pending nudges against what the owner actually did.
 * `touched` is the set of repo names the harvest changed. This is what feeds
 * the cooldown and shrink logic, so it runs before `selectNudge`.
 */
export function resolveOutcomes(nudges, { touched = [], date = isoDate(Date.now()), interacted = false } = {}) {
  const state = stateOf(nudges);
  const resolved = [];

  for (const entry of historyOf(nudges)) {
    if (entry.outcome !== 'pending' || entry.date === date) continue;
    const acted = interacted || (entry.repos ?? []).some((r) => touched.includes(r));
    entry.outcome = acted ? 'acted' : 'ignored';
    resolved.push(entry);

    if (entry.type === 'shrunk') {
      for (const repo of entry.repos ?? []) {
        state.shrunk_ignored[repo] = acted ? 0 : (state.shrunk_ignored[repo] ?? 0) + 1;
      }
    }
    if (acted) {
      for (const repo of entry.repos ?? []) {
        delete state.muted[repo];
        delete state.shrunk_ignored[repo];
      }
    }
  }
  return resolved;
}

/** Apply a decision's effects to portfolio + nudges. The Routine calls this. */
export function applyDecision(portfolio, nudges, decision) {
  const state = stateOf(nudges);
  if (decision.effects?.shrink) {
    portfolio.session = { ...(portfolio.session ?? {}), shrink: true, batch_key: decision.effects.shrink.batch_key };
  }
  if (decision.effects?.question) {
    portfolio.questions = portfolio.questions ?? [];
    const q = decision.effects.question;
    if (q && !portfolio.questions.some((existing) => existing.repo === q.repo)) portfolio.questions.push(q);
  }
  for (const repo of decision.effects?.mute ?? []) {
    try {
      getRepo(portfolio, repo);
      state.muted[repo] = decision.record?.date ?? isoDate(Date.now());
    } catch {
      /* a repo that left the portfolio needs no muting */
    }
  }
  if (decision.record) (nudges.history ??= []).push(decision.record);
  return { portfolio, nudges };
}

/* -------------------------------------------------------------------- CLI */

function main(argv) {
  const date = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? isoDate(Date.now());
  const portfolio = load();
  const nudges = existsSync(NUDGES_PATH) ? JSON.parse(readFileSync(NUDGES_PATH, 'utf8')) : { history: [] };
  const decisionsFile = new URL('../data/decisions.json', import.meta.url);
  const { decisions } = JSON.parse(readFileSync(decisionsFile, 'utf8'));

  const d = selectNudge(portfolio, nudges, { date, decisions });
  console.log(`\n${date} — ${d.push ? 'PUSH' : 'silent'}  (${d.reason})\n`);
  if (d.title) console.log(`  ${d.title}\n  ${d.body}\n`);
  if (d.repos?.length) console.log(`  repos: ${d.repos.join(', ')}`);
  const queue = launchQueue(portfolio);
  console.log(`  queue: ${queue.length} owner-blocked repos ≥70%\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
