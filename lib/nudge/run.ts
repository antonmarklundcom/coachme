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

import { localDate, safeTimeZone, addDays } from '../clock';
import {
  getDecisions,
  getNudges,
  getOpenVerifyItems,
  getOwnerActions,
  getRepos,
  getSettings,
  patchSessionState,
  recordNudge,
  setNudgeOutcome,
} from '../queries';
import { CAPS, type NudgeRecord } from './history';
import { type LadderDecision, type SessionState, selectNudge } from './ladder';
import { resolveOutcomes } from './outcomes';
import { pushConfigured, sendPush, type PushResult } from '../push';

export interface NudgeRunOptions {
  source: 'cron' | 'manual';
  /** Override today's owner-local date. Testing and replay only. */
  date?: string;
  now?: number;
  /** Decide and record, but never deliver. Used by the dry-run CLI. */
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

  const [repos, history, decisions, verifyItems] = await Promise.all([
    getRepos(),
    getNudges(),
    getDecisions('pending'),
    getOpenVerifyItems(),
  ]);

  // --- 1. resolve yesterday, so today is decided from current memory.
  const actions = await getOwnerActions(activitySince(history, date));
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
    pendingDecisions: decisions.map((d) => ({ id: d.id, created_at: String(d.created_at) })),
    verifyItems: verifyItems.map((v) => ({ repo_name: v.repo_name, created_at: String(v.created_at) })),
  });

  const summary = resolved.map((r) => ({ id: r.id, outcome: r.outcome }));
  if (!decision.type) {
    // A silence is not recorded: `decidedOn` would then treat the Sunday branch
    // and the "nothing qualifies" branch as a decision that blocks tomorrow's
    // run from ever reconsidering. The history holds asks, not non-asks.
    console.log(`[nudge] ${date} silent — ${decision.reason}`);
    return { date, timezone, source: opts.source, decision, resolved: summary, nudgeId: null, push: null, dryRun: !!opts.dryRun };
  }

  // --- 3. record the decision. Written BEFORE the push is attempted so a
  // failed delivery can never be retried into a second notification.
  const nudgeId = await recordNudge({
    local_date: date,
    type: decision.type,
    repo_names: decision.repos,
    pushed: decision.push && !opts.dryRun,
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
  if (decision.push && !opts.dryRun) {
    push = await sendPush({
      title: decision.title ?? 'coachme',
      body: decision.body ?? '',
      url: '/',
      tag: 'coachme-nudge',
    });
  } else if (decision.push && opts.dryRun) {
    push = { sent: 0, failed: 0, pruned: 0, skipped: 'dry run' };
  }

  console.log(
    `[nudge] ${date} ${decision.push ? 'PUSH' : 'silent'} ${decision.type} ` +
      `[${decision.repos.join(', ')}] — ${decision.reason}` +
      (push?.skipped ? ` (not delivered: ${push.skipped})` : '')
  );

  return { date, timezone, source: opts.source, decision, resolved: summary, nudgeId, push, dryRun: !!opts.dryRun };
}

export { pushConfigured };
