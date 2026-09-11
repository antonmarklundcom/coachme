/**
 * dispatch/merge.ts — the Merge button.
 *
 * One tap on the dashboard, one squash merge, one status change. Every guard
 * that matters is in lib/github/write.ts (`mergePull`): branch prefix, open,
 * conflict-free, green. This file adds only the app-side ones — the item must
 * actually have a PR, and it must be in a state where merging means something.
 *
 * The stage raise that a merged item may justify is NOT done here. It belongs
 * to the scan, which raises stages from evidence it has fetched (plan.md §2);
 * a merge is a promise that something changed, not proof that it did.
 */

import { type WorkItem } from '../domain';
import { GithubWriteRefused, mergePull } from '../github/write';
import { getRepoById, getWorkItem, setWorkItemStatus } from '../queries';
import { OWNER } from './run';

export interface MergeResult {
  item: WorkItem;
  sha: string;
}

export async function mergeWorkItem(workItemId: number): Promise<MergeResult> {
  const item = await getWorkItem(workItemId);
  if (!item) throw new Error(`work item ${workItemId} does not exist`);
  if (!item.pr_number) throw new GithubWriteRefused(`"${item.slug}" has no pull request to merge`);
  if (item.status === 'merged' || item.status === 'done') {
    throw new GithubWriteRefused(`"${item.slug}" is already ${item.status}`);
  }

  const repo = await getRepoById(item.repo_id);
  if (!repo) throw new Error(`repo ${item.repo_id} does not exist`);

  const { sha } = await mergePull(repo.github_full_name ?? `${OWNER}/${repo.name}`, item.pr_number);
  const updated = await setWorkItemStatus(item.id, 'merged', { pr_state: 'merged' });
  return { item: updated, sha };
}
