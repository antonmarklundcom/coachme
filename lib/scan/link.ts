/**
 * scan/link.ts — finding the work again (Decision D-G).
 *
 * A dispatched prompt walks out of this app and comes back days later as a pull
 * request on someone else's repository. Two things tie it to the work item that
 * asked for it, both written by the mandatory prompt header:
 *
 *   the head branch  `coachme/<slug>`
 *   the PR title     `[coachme:<slug>] …`
 *
 * The branch is the primary key; the title marker is the fallback for when an
 * agent (or Anton) renamed the branch. Nothing else counts — in particular a
 * bare `claude/*` branch does NOT link, because Anton runs Claude Code on these
 * repos constantly for unrelated reasons, and a coach that claimed credit for
 * every session he ever ran would make the desk's state meaningless.
 *
 * Pure: pulls in, matches out.
 */

import { branchFor, type WorkItem } from '../domain';
import type { PullDetail } from './github';

/** The marker the prompt header puts in every dispatched PR's title. */
export function titleMarker(slug: string): string {
  return `[coachme:${slug}]`;
}

export function matches(item: Pick<WorkItem, 'slug'>, pull: PullDetail): boolean {
  return pull.head?.ref === branchFor(item.slug) || (pull.title ?? '').includes(titleMarker(item.slug));
}

/**
 * The pull request for each item, newest first when several match (an agent
 * that opened a second PR from the same branch is telling us the later one is
 * the live attempt).
 */
export function linkPulls<T extends Pick<WorkItem, 'id' | 'slug'>>(
  items: T[],
  pulls: PullDetail[]
): { item: T; pull: PullDetail }[] {
  const out: { item: T; pull: PullDetail }[] = [];
  for (const item of items) {
    const candidates = pulls
      .filter((p) => matches(item, p))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    // An open PR beats a closed one: a closed attempt followed by a new one is
    // the common shape, and the open one is what the owner can act on.
    const open = candidates.find((p) => p.state === 'open' && !p.merged);
    const merged = candidates.find((p) => p.merged);
    const pull = open ?? merged ?? candidates[0];
    if (pull) out.push({ item, pull });
  }
  return out;
}
