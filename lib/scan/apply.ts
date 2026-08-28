/**
 * scan/apply.ts — the drift guard.
 *
 * Ported from scripts/legacy/src/refresh.js `applyScan`, and deliberately
 * asymmetric in exactly the way SCAN.md's "What the scan may and may not
 * change" table is:
 *
 *   percentage up ............... applied
 *   percentage down ............. held as a verify item
 *   new blocker, never cleared .. applied, flagged "newly blocked on you"
 *   blocker the owner cleared ... held as a verify item
 *   live URL answers ............ launched at 100%
 *   owner-blocked 3 scans ....... flagged stuck
 *
 * The rule underneath: **a scan is an estimate, a tick is a fact.** When they
 * disagree the coach asks; it never silently reverts a human. This module is
 * pure so that rule is unit-testable — the writes live in scan/run.ts.
 */

import {
  BLOCKERS,
  type Blocker,
  LANES,
  type Lane,
  type Repo,
  hasOwnerClearedBlocker,
  isOwnerBlocked,
  isoDate,
} from '../domain';

/** How many consecutive scans a repo may sit owner-blocked before it is called out. */
export const BLOCKED_SCANS_LIMIT = 3;

/** What one deep scan claims to have found. Every field is optional: absent
 *  means "the scan learned nothing new", never "the value is empty". */
export interface ScanFinding {
  pct?: number;
  last_commit?: string;
  pushed_at?: string;
  head?: string;
  blocker?: string;
  lane?: string;
  next_step?: string;
  open_prs?: number;
  merged_prs_30d?: number;
  live_url?: string;
  live_url_ok?: boolean;
  launched?: boolean;
}

export interface ScanDecision {
  /** Column updates that are safe to write. */
  patch: Record<string, unknown>;
  /** Human-readable log of what changed. */
  changes: string[];
  /** Set when the finding contradicts a human tick — the update is withheld. */
  verifyReason: string | null;
  launched: boolean;
}

/**
 * Decide what one finding does to one repo. Nothing here writes; the caller
 * records a `scan_events` row first and applies `patch` second.
 */
export function decideScanUpdate(
  repo: Repo,
  finding: ScanFinding,
  { date = isoDate(), now = Date.now() }: { date?: string; now?: number } = {}
): ScanDecision {
  const patch: Record<string, unknown> = { last_scan_at: new Date(now).toISOString() };
  const changes: string[] = [];
  const verifyReasons: string[] = [];

  // --- bookkeeping the scan is always allowed to refresh.
  if (finding.pushed_at) patch.pushed_at = finding.pushed_at;
  if (finding.head) patch.last_scan_head_sha = finding.head;
  if (finding.last_commit) patch.last_commit_at = finding.last_commit;
  if (typeof finding.open_prs === 'number') patch.open_prs = finding.open_prs;
  if (typeof finding.merged_prs_30d === 'number') patch.merged_prs_30d = finding.merged_prs_30d;
  if (finding.next_step) patch.next_step = finding.next_step;
  if (finding.live_url) patch.live_url = finding.live_url;
  if (typeof finding.live_url_ok === 'boolean') patch.live_url_ok = finding.live_url_ok;

  // --- completion: moves freely upward, and downward only with a question. A
  // percentage that falls is usually the scan being pessimistic, not work
  // being undone.
  if (typeof finding.pct === 'number' && finding.pct !== repo.pct) {
    if (finding.pct >= repo.pct) {
      changes.push(`${repo.name}: ${repo.pct}% → ${finding.pct}%`);
      patch.pct = finding.pct;
    } else {
      verifyReasons.push(
        `the scan reads ${repo.name} as ${finding.pct}% done, the record says ${repo.pct}%. Which is right?`
      );
    }
  }

  // --- launch detection: a live URL that answers, or the scan saying so.
  if ((finding.live_url_ok === true || finding.launched === true) && !repo.launched_at) {
    patch.launched_at = date;
    patch.pct = 100;
    patch.blocker = 'none';
    patch.lane = 'launch-agent-drivable';
    patch.blocked_scans = 0;
    patch.newly_blocked_at = null;
    changes.push(`${repo.name}: detected live`);
    return { patch, changes, verifyReason: verifyReasons.join(' ') || null, launched: true };
  }

  // --- blockers. THE DRIFT GUARD: a repo the owner ticked clear is never
  // silently re-blocked. The scan may be reading a stale deploy, and un-ticking
  // someone's finished work is the fastest way to lose their trust in the whole
  // system.
  const nextBlocker = finding.blocker as Blocker | undefined;
  const nextLane = finding.lane as Lane | undefined;
  let blockerAfter: Blocker = repo.blocker;

  if (nextBlocker && BLOCKERS.includes(nextBlocker) && nextBlocker !== repo.blocker) {
    if (nextBlocker !== 'none' && hasOwnerClearedBlocker(repo) && repo.blocker === 'none') {
      verifyReasons.push(
        `you marked ${repo.name} unblocked, but the scan still sees "${nextBlocker}". Did it actually go through?`
      );
    } else {
      const was = repo.blocker;
      patch.blocker = nextBlocker;
      blockerAfter = nextBlocker;
      if (nextLane && LANES.includes(nextLane)) patch.lane = nextLane;
      changes.push(`${repo.name}: blocker ${was} → ${nextBlocker}`);
      // Crossing INTO owner-blocked is the signal worth surfacing: new work
      // landing on the owner's plate without them asking for it.
      if (!isOwnerBlocked({ blocker: was }) && isOwnerBlocked({ blocker: nextBlocker })) {
        patch.newly_blocked_at = date;
        changes.push(`${repo.name}: newly blocked on you`);
      }
      if (!isOwnerBlocked({ blocker: nextBlocker })) patch.newly_blocked_at = null;
    }
  } else if (nextLane && LANES.includes(nextLane) && nextLane !== repo.lane) {
    changes.push(`${repo.name}: lane ${repo.lane} → ${nextLane}`);
    patch.lane = nextLane;
  }

  // --- how long has this been sitting on the owner?
  if (isOwnerBlocked({ blocker: blockerAfter })) {
    const count = (repo.blocked_scans ?? 0) + 1;
    patch.blocked_scans = count;
    if (count === BLOCKED_SCANS_LIMIT) {
      changes.push(`${repo.name}: owner-blocked for ${BLOCKED_SCANS_LIMIT} scans running`);
    }
  } else {
    patch.blocked_scans = 0;
  }

  return { patch, changes, verifyReason: verifyReasons.join(' ') || null, launched: false };
}

/* ------------------------------------------------------------------- sweep */

const DAY = 24 * 60 * 60 * 1000;
const asTime = (iso: string | null) => (iso ? Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso) : NaN);

/** A repo untouched for this long earns a scope-review question. */
export const STALE_DAYS = 30;
/** The scope question is monthly. Asking again a week later is nagging. */
export const REVIEW_INTERVAL_DAYS = 28;

export function reviewDue(scopeReviewLast: string | null, date: string): boolean {
  if (!scopeReviewLast) return true;
  return (asTime(date) - asTime(scopeReviewLast)) / DAY >= REVIEW_INTERVAL_DAYS;
}

/**
 * Flag repos nobody has touched in a month for the scope review. Nearly
 * finished work is exempt: "untouched" asks whether a project should exist, and
 * a 95% repo has already answered.
 */
export function stalenessSweep(
  repos: Repo[],
  {
    now = Date.now(),
    days = STALE_DAYS,
    maxPct = 70,
    date = isoDate(now),
    scopeReviewLast = null,
  }: { now?: number; days?: number; maxPct?: number; date?: string; scopeReviewLast?: string | null } = {}
): string[] {
  if (!reviewDue(scopeReviewLast, date)) return [];
  const flagged: string[] = [];
  for (const repo of repos) {
    if (repo.pct >= maxPct || repo.launched_at) continue;
    if (repo.killed_at || (repo.snoozed_until && asTime(repo.snoozed_until) > asTime(date))) continue;
    if (repo.scope_review_due) continue;
    const last = repo.last_commit_at ?? repo.pushed_at;
    if (!last) continue;
    if ((now - asTime(last)) / DAY < days) continue;
    flagged.push(repo.name);
  }
  return flagged;
}

/**
 * Repos asked about twice with no answer get *proposed* as a snooze rather than
 * asked a third time (DESIGN.md §2.5). Proposed — never applied.
 */
export function autoProposeSnooze(repos: Repo[], { reviews = 2 }: { reviews?: number } = {}): {
  name: string;
  unanswered: number;
  propose: boolean;
}[] {
  const out = [];
  for (const repo of repos) {
    if (!repo.scope_review_due) continue;
    const unanswered = (repo.scope_reviews_unanswered ?? 0) + 1;
    out.push({
      name: repo.name,
      unanswered,
      propose: unanswered >= reviews && !repo.scope_review_proposed,
    });
  }
  return out;
}
