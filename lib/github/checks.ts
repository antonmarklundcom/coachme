/**
 * github/checks.ts — is this PR green?
 *
 * Pure, so the one question the merge guard turns on is unit-testable without a
 * network: `mergePull` refuses anything this file does not call `green`.
 *
 * The judgement call, recorded here because it is the kind of thing that looks
 * like a bug later: **a PR with no checks at all is green.** Most of Anton's
 * repositories are static PHP sites with no CI; treating "no checks" as "not
 * green" would mean the merge button never works anywhere it is most needed.
 * The safeguard is that the button is still a deliberate human tap, and that a
 * repo which HAS CI can never be merged red.
 */

import type { PrState } from '../domain';
import type { CheckRun, CommitStatus, PullDetail } from '../scan/github';

/** Conclusions that do not stand in the way of a merge. */
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const OK_STATUSES = new Set(['success']);

export interface ChecksInput {
  runs: CheckRun[];
  statuses: CommitStatus[];
  /** Neither CI endpoint answered. Not the same as "no checks" — see below. */
  unknown?: boolean;
}

export function isPending(checks: ChecksInput): boolean {
  return (
    checks.runs.some((r) => r.status !== 'completed') ||
    checks.statuses.some((s) => s.state === 'pending')
  );
}

export function isRed(checks: ChecksInput): boolean {
  return (
    checks.runs.some((r) => r.status === 'completed' && !OK_CONCLUSIONS.has(r.conclusion ?? '')) ||
    checks.statuses.some((s) => s.state !== 'pending' && !OK_STATUSES.has(s.state))
  );
}

/**
 * Green means: nothing failed, nothing is still running, and we actually know
 * that. An unreachable checks API is never green — otherwise a rate limit or a
 * network blip would turn the merge guard off exactly when it is least visible.
 */
export function isGreen(checks: ChecksInput): boolean {
  return !checks.unknown && !isRed(checks) && !isPending(checks);
}

/**
 * The `pr_state` column's value for one PR: what the work desk renders and what
 * the Merge button is enabled on.
 *
 * `conflict` outranks the CI state — a PR that cannot merge is not "green" in
 * any sense the owner cares about, whatever its tests say.
 */
export function prState(pull: Pick<PullDetail, 'merged' | 'state' | 'mergeable_state' | 'draft'>, checks: ChecksInput): PrState {
  if (pull.merged) return 'merged';
  if (pull.mergeable_state === 'dirty') return 'conflict';
  if (pull.draft) return 'open';
  if (isRed(checks)) return 'red';
  if (isPending(checks) || checks.unknown) return 'open';
  return 'green';
}
