/**
 * launch/items.ts — the work item's status machine (plan.md §5 O3).
 *
 * Pure. Every write to `work_items.status` goes through `assertTransition`, so
 * the illegal moves are illegal in one place rather than in each caller:
 *
 *   proposed ──approve──▶ approved ──dispatch──▶ dispatched
 *                                                   │ scan sees the branch
 *                                                   ▼
 *                                             in_progress
 *                                                   │ scan sees the PR
 *                                                   ▼
 *                                               pr_open ──merge──▶ merged ──▶ done
 *
 * Anything may be dropped. Nothing may skip `approved`: that tick is the whole
 * consent model (Decision D-D) — an item that could reach `dispatched` without
 * it would let the generator write to Anton's repos on its own judgement.
 *
 * `dispatched → pr_open` is legal without passing through `in_progress`: the
 * scan runs twice a week, and an agent that opened its PR between two scans
 * never had a branch-without-PR moment for the scan to see.
 */

import { WORK_STATUSES, type WorkStatus } from '../domain';

/** status → the statuses it may become (besides itself and `dropped`). */
const NEXT: Record<WorkStatus, WorkStatus[]> = {
  proposed: ['approved'],
  approved: ['dispatched'],
  // A dispatch that turns out to be wrong goes back to `approved` so it can be
  // sent to the other target; it never goes back to `proposed`, because the
  // approval already happened and re-asking for it would be theatre.
  dispatched: ['in_progress', 'pr_open', 'approved'],
  in_progress: ['pr_open'],
  // A PR can close without merging; the item is then back to work in progress
  // on the same branch rather than un-dispatched.
  pr_open: ['merged', 'in_progress'],
  merged: ['done'],
  done: [],
  dropped: [],
};

export class IllegalTransition extends Error {}

export function canTransition(from: WorkStatus, to: WorkStatus): boolean {
  if (!WORK_STATUSES.includes(to)) return false;
  if (from === to) return true; // idempotent: the scan re-asserts what it sees
  if (to === 'dropped') return from !== 'dropped';
  return (NEXT[from] ?? []).includes(to);
}

export function assertTransition(from: WorkStatus, to: WorkStatus): WorkStatus {
  if (!canTransition(from, to)) {
    throw new IllegalTransition(`work item cannot go from "${from}" to "${to}"`);
  }
  return to;
}

/** Statuses that mean "this repo already has work in flight" (§2: no new
 *  proposals while one is live). */
export const IN_FLIGHT: WorkStatus[] = ['approved', 'dispatched', 'in_progress', 'pr_open'];

/** Statuses nothing will move on their own again. */
export const TERMINAL: WorkStatus[] = ['done', 'dropped'];

export function isInFlight(status: WorkStatus): boolean {
  return IN_FLIGHT.includes(status);
}

export function isTerminal(status: WorkStatus): boolean {
  return TERMINAL.includes(status);
}

/** What the scan concludes from what it can see on GitHub (Decision D-G). */
export function statusFromGithub(
  current: WorkStatus,
  seen: { branch?: boolean; pr?: boolean; merged?: boolean }
): WorkStatus {
  if (isTerminal(current) || current === 'proposed' || current === 'approved') return current;
  if (seen.merged) return 'merged';
  if (seen.pr) return 'pr_open';
  if (seen.branch && current === 'dispatched') return 'in_progress';
  return current;
}
