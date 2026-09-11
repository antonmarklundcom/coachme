/**
 * nudge/run.ts — the daily run (plan.md §5 O2).
 *
 * The old `ROUTINE.md` run was five steps: harvest, refresh-lite, select,
 * render, notify. Three of them are gone — ticks write straight to Neon so
 * there is nothing to harvest, the twice-weekly `/api/scan` does the refresh,
 * and the dashboard renders itself from live state. What is left is the part
 * that was always the point:
 *
 *   1. resolve — settle yesterday's pending nudges against what the owner did
 *   2. select  — run the ladder (lib/nudge/ladder.ts)
 *   3. record  — write the decision, push or silence, to `nudges`
 *   4. notify  — deliver a Web Push, if the decision earned one
 *
 * Step 1 runs before step 2 on purpose: the outcome of yesterday's ask is what
 * lifts a mute, resets the shrink counter and ends a cooldown, so selecting
 * first would decide today from stale memory.
 */

import { localDate, localDateOf, safeTimeZone, addDays, weekdayOf } from '../clock';
import type { Repo, WorkItem } from '../domain';
import {
  getDecisions,
  getNudges,
  getWorkItems,
  getOpenVerifyItems,
  getOwnerActions,
  getRepos,
  getSettings,
  patchSessionState,
  recordNudge,
  setNudgeOutcome,
} from '../queries';
import { moneyQueue } from '../score';
import { writeWeeklyReport, type WeeklyReport } from '../report/weekly';
import { CAPS, type NudgeRecord } from './history';
import { type LadderDecision, type LadderWork, type SessionState, selectNudge } from './ladder';
import { resolveOutcomes } from './outcomes';
import { pushConfigured, sendPush, type PushResult } from '../push';

export interface NudgeRunOptions {
  source: 'cron' | 'manual';
  /** Override today's owner-local date. Testing and replay only. */
  date?: string;
  now?: number;
  /** Decide and report, writing nothing and delivering nothing. */
  dryRun?: boolean;
}

export interface NudgeRunResult {
  date: string;
  timezone: string;
  source: 'cron' | 'manual';
  decision: LadderDecision;
  resolved: { id: number; outcome: string }[];
  nudgeId: number | null;
  push: PushResult | null;
  dryRun: boolean;
  /** Written on Mondays only (Decision D-J); null every other day. */
  weeklyReport: WeeklyReport | null;
}

/** Monday, in the owner's week. `weekdayOf` counts Sunday as 0. */
export const REPORT_WEEKDAY = 1;

/**
 * What the launch desk has waiting, in the shape the ladder's two new rungs
 * want it. Pure assembly — the ordering decision (which repo's owner step is
 * THE owner step) is `moneyQueue`'s, so the digest and the dashboard cannot
 * disagree about what is closest to money.
 */
export function collectWork(repos: Repo[], items: WorkItem[], date: string): LadderWork {
  const nameOf = new Map(repos.map((r) => [r.id, r.name]));
  const name = (item: WorkItem) => nameOf.get(item.repo_id) ?? String(item.repo_id);

  const green = items
    .filter((i) => i.status === 'pr_open' && i.pr_state === 'green')
    .map((i) => ({ repo: name(i), slug: i.slug, title: i.title }));

  const proposed = items
    .filter((i) => i.status === 'proposed')
    .map((i) => ({ repo: name(i), slug: i.slug, title: i.title }));

  let ownerStep: LadderWork['ownerStep'] = null;
  for (const entry of moneyQueue(repos, { date })) {
    // An approved step outranks an unapproved one on the same repo: Anton has
    // already said yes to it, so asking about anything else there is noise.
    const candidates = items.filter(
      (i) => i.repo_id === entry.repo.id && i.kind === 'owner' && ['approved', 'dispatched', 'proposed'].includes(i.status)
    );
    const step =
      candidates.find((i) => i.status === 'approved' || i.status === 'dispatched') ?? candidates[0];
    if (step) {
      ownerStep = { repo: entry.repo.name, slug: step.slug, title: step.title, minutes: step.estimate_minutes };
      break;
    }
  }

  return { green, proposed, ownerStep };
}

/**
 * How far back to look for owner activity, at minimum. Nothing older than the
 * longest memory in the state machine can still change today's decision, so
 * this is the floor.
 *
 * It is only a floor, though: the evidence has to reach back to the OLDEST
 * still-pending nudge, or that nudge gets resolved against a window it predates
 * and is marked ignored even though the owner acted. Normally nothing is
 * pending for more than a day — every run resolves everything older than today
 * — but if the cron is down for a fortnight, a fixed window would quietly
 * convert the whole backlog into ignores, escalate to a question, and mute the
 * repo for a week. Losing that much of the owner's credit is not an acceptable
 * failure mode for a coach whose entire job is not to nag wrongly.
 */
const ACTIVITY_WINDOW_DAYS = Math.max(CAPS.repoCooldownDays, CAPS.muteDays) + 7;

/** The earliest date the evidence query must cover, given what is still open. */
export function activitySince(history: NudgeRecord[], date: string): string {
  const floor = addDays(date, -ACTIVITY_WINDOW_DAYS);
  const oldestPending = history.find((h) => h.outcome === 'pending' && h.local_date < date);
  return oldestPending && oldestPending.local_date < floor ? oldestPending.local_date : floor;
}

export async function runNudge(opts: NudgeRunOptions): Promise<NudgeRunResult> {
  const settings = await getSettings();
  const timezone = safeTimeZone(settings.owner_timezone);
  const date = opts.date ?? localDate(opts.now ?? Date.now(), timezone);

  const [repos, history, decisions, verifyItems, items] = await Promise.all([
    getRepos(),
    getNudges(),
    getDecisions('pending'),
    getOpenVerifyItems(),
    getWorkItems(),
  ]);

  // --- 1. resolve yesterday, so today is decided from current memory.
  const actions = await getOwnerActions(activitySince(history, date), timezone);
  const resolved = resolveOutcomes(history, actions, date);
  for (const item of resolved) {
    await setNudgeOutcome(item.id, item.outcome, item.evidence);
    // Keep the in-memory copy in step with the database — the ladder is about
    // to read this same array, and a stale 'pending' would hide a lifted mute.
    const entry = history.find((h) => h.id === item.id);
    if (entry) entry.outcome = item.outcome;
  }

  // --- 2. run the ladder.
  const decision = selectNudge({
    date,
    repos,
    history,
    session: (settings.session_state ?? {}) as SessionState,
    // Collapsed to an owner-local day here rather than in the ladder: the
    // ladder is pure and must not know about timezones or driver types.
    pendingDecisions: decisions.map((d) => ({
      id: d.id,
      created_at: localDateOf(d.created_at, timezone) ?? date,
    })),
    verifyItems: verifyItems.map((v) => ({
      repo_name: v.repo_name,
      created_at: localDateOf(v.created_at, timezone) ?? date,
    })),
    work: collectWork(repos, items, date),
  });

  const summary = resolved.map((r) => ({ id: r.id, outcome: r.outcome }));

  // The weekly money report rides on the Monday run rather than a third cron:
  // the Hobby plan allows exactly two, and this needs no schedule of its own
  // (plan.md §1, Decision D-J). Written before the decision is recorded so a
  // failure to push cannot cost the report. A dry run writes nothing.
  let weeklyReport: WeeklyReport | null = null;
  if (weekdayOf(date) === REPORT_WEEKDAY && !opts.dryRun) {
    try {
      weeklyReport = await writeWeeklyReport(date);
    } catch (err) {
      console.error('[nudge] weekly report failed', err);
    }
  }
  if (!decision.type) {
    // A silence is not recorded: `decidedOn` would then treat the Sunday branch
    // and the "nothing qualifies" branch as a decision that blocks tomorrow's
    // run from ever reconsidering. The history holds asks, not non-asks.
    console.log(`[nudge] ${date} silent — ${decision.reason}`);
    return { date, timezone, source: opts.source, decision, resolved: summary, nudgeId: null, push: null, dryRun: !!opts.dryRun, weeklyReport };
  }

  // A dry run decides and reports; it does not consume the day. Recording it
  // would make `decidedOn` true, and the real cron four hours later would find
  // the day already answered and deliver nothing — a preview that silently
  // cancels the actual nudge is not a preview.
  if (opts.dryRun) {
    console.log(`[nudge] ${date} DRY RUN ${decision.type} [${decision.repos.join(', ')}] — ${decision.reason}`);
    return {
      date, timezone, source: opts.source, decision, resolved: summary,
      nudgeId: null,
      push: { sent: 0, failed: 0, pruned: 0, skipped: 'dry run' },
      dryRun: true,
      weeklyReport,
    };
  }

  // --- 3. record the decision. Written BEFORE the push is attempted so a
  // failed delivery can never be retried into a second notification.
  const nudgeId = await recordNudge({
    local_date: date,
    type: decision.type,
    repo_names: decision.repos,
    pushed: decision.push,
    shrunk: !!decision.shrunk,
    parent_type: decision.parentType ?? null,
    title: decision.title ?? null,
    body: decision.body ?? null,
    note: decision.reason,
  });

  if (decision.effects.shrink) {
    await patchSessionState({ shrink: true, batch_key: decision.effects.shrink.batch_key });
  }

  // --- 4. notify, if the ladder produced a real ask.
  let push: PushResult | null = null;
  if (decision.push) {
    push = await sendPush({
      title: decision.title ?? 'coachme',
      body: decision.body ?? '',
      url: '/',
      tag: 'coachme-nudge',
    });
  }

  console.log(
    `[nudge] ${date} ${decision.push ? 'PUSH' : 'silent'} ${decision.type} ` +
      `[${decision.repos.join(', ')}] — ${decision.reason}` +
      (push?.skipped ? ` (not delivered: ${push.skipped})` : '')
  );

  return { date, timezone, source: opts.source, decision, resolved: summary, nudgeId, push, dryRun: !!opts.dryRun, weeklyReport };
}

export { pushConfigured };
