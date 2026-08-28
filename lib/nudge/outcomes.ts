/**
 * nudge/outcomes.ts — did the owner act on yesterday's ask?
 *
 * The legacy coach answered this from the harvest: it re-read the live-doc,
 * diffed the checked boxes, and handed `select.js` the set of repos that moved.
 * There is no live-doc and no harvest any more — ticks write straight to Neon —
 * so the same question is answered from the state those writes leave behind.
 *
 * This matters more than it looks: `outcome` is what lifts a mute, resets the
 * shrink counter, and ends a repo's cooldown. If nothing ever resolved to
 * 'acted', the coach would escalate every ask to a question and then go silent
 * on the whole portfolio.
 *
 * Pure: the caller gathers the evidence, this decides what it means.
 */

import type { NudgeRecord } from './history';

/**
 * One thing the owner did, and when. `repo === null` means an action with no
 * single repo behind it (answering the decisions inbox), which is what resolves
 * a nudge that named no repos.
 */
export interface OwnerAction {
  repo: string | null;
  date: string;
  what: string;
}

export interface ResolvedOutcome {
  id: number;
  outcome: 'acted' | 'ignored';
  /** The action that settled it, for the audit trail. */
  evidence: string | null;
}

/**
 * Resolve every still-pending nudge from a day before `date`.
 *
 * Today's own row is left alone: the owner has not had the day yet, and marking
 * it ignored would corrupt the chain the very next run reads.
 */
export function resolveOutcomes(
  history: NudgeRecord[],
  actions: OwnerAction[],
  date: string
): ResolvedOutcome[] {
  const resolved: ResolvedOutcome[] = [];

  for (const entry of history) {
    if (entry.outcome !== 'pending' || entry.local_date >= date) continue;

    const match = actions.find((action) => {
      // An action cannot answer an ask that had not been made yet.
      if (action.date < entry.local_date) return false;
      const repos = entry.repo_names ?? [];
      return action.repo === null ? repos.length === 0 : repos.includes(action.repo);
    });

    resolved.push({
      id: entry.id,
      outcome: match ? 'acted' : 'ignored',
      evidence: match ? `${match.what} (${match.date})` : null,
    });
  }
  return resolved;
}
