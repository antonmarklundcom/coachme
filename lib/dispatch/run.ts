/**
 * dispatch/run.ts — handing one approved work item to whoever will do it.
 *
 * The dispatch primitive is a file commit (Decision D-E): the prompt lands at
 * `prompts/coachme/<slug>.md` on the target repo's default branch, and Anton
 * pastes one line into Claude Code or Codex. That is the whole mechanism — no
 * webhook, no API into an agent, nothing to keep running. The same file works
 * for both tools because both read the repo they are pointed at.
 *
 * Three targets:
 *   repo-file  commit the prompt (needs a write-scoped PAT)
 *   issue      open an issue with the same body (needs the same)
 *   copy       write nothing at all; the owner pastes the prompt himself
 *
 * `copy` is not a lesser mode — it is what makes the desk useful on day one,
 * before any PAT exists, and it is the automatic fallback when the token turns
 * out to be read-only. A dispatch that fails because of a missing credential
 * should cost the owner one paste, not the whole feature (plan.md §4.5).
 */

import {
  branchFor,
  type DispatchTarget,
  type WorkItem,
} from '../domain';
import {
  GithubWriteRefused,
  GithubWriteUnavailable,
  createIssue,
  putPromptFile,
} from '../github/write';
import { getRepoById, getWorkItem, recordDispatch, setWorkItemStatus, updateWorkItem } from '../queries';

export const OWNER = 'antonmarklundcom';

export interface DispatchResult {
  item: WorkItem;
  target: DispatchTarget;
  /** What the owner pastes into Claude Code or Codex. Always present. */
  one_liner: string;
  commit_sha: string | null;
  issue_url: string | null;
  /** Set when a write target degraded to `copy`, with the reason why. */
  degraded: string | null;
}

export async function dispatch(workItemId: number, target: DispatchTarget): Promise<DispatchResult> {
  const item = await getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} does not exist`);

  // The consent gate (Decision D-D). `setWorkItemStatus` would refuse the
  // transition anyway; refusing here means nothing is written to GitHub first.
  if (item.status !== 'approved') {
    throw new GithubWriteRefused(
      `work item "${item.slug}" is ${item.status} — only an approved item can be dispatched`
    );
  }

  // An owner step is a note to a human. Committing it into a repository would
  // put a to-do list in someone's source tree and teach an agent to do the one
  // kind of work it must not touch.
  if (item.kind === 'owner' && target !== 'copy') {
    throw new GithubWriteRefused(`"${item.slug}" is an owner step — it can only be copied, not committed`);
  }

  const repo = await getRepoById(item.repo_id);
  if (!repo) throw new Error(`repo ${item.repo_id} does not exist`);
  const fullName = repo.github_full_name ?? `${OWNER}/${repo.name}`;

  let effective: DispatchTarget = target;
  let commit_sha: string | null = null;
  let issue_url: string | null = null;
  let degraded: string | null = null;

  if (target !== 'copy') {
    try {
      if (target === 'repo-file') {
        commit_sha = (await putPromptFile(fullName, item.slug, item.prompt_md)).commit_sha;
      } else {
        issue_url = (await createIssue(fullName, `[coachme:${item.slug}] ${item.title}`, item.prompt_md))
          .issue_url;
      }
    } catch (err) {
      if (!(err instanceof GithubWriteUnavailable)) throw err;
      // No write scope. Nothing reached GitHub, so the item is still perfectly
      // dispatchable by hand — say so rather than failing the tap.
      effective = 'copy';
      degraded = `${err.message} — dispatched as a copy instead`;
    }
  }

  await recordDispatch(item.id, effective, { commit_sha, issue_url });
  await updateWorkItem(item.id, {
    dispatched_at: new Date().toISOString(),
    branch: item.kind === 'agent' ? branchFor(item.slug) : null,
    ...(degraded ? { note: degraded } : {}),
  });
  const updated = await setWorkItemStatus(item.id, 'dispatched');

  return { item: updated, target: effective, one_liner: updated.one_liner, commit_sha, issue_url, degraded };
}
