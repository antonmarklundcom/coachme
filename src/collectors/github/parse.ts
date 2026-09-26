import { ciState, type CI } from './ci.js';
import { redact } from '../../lib/redact.js';
interface Commit { committedDate?: string; statusCheckRollup?: { state?: string } | null }
interface Repo {
  name: string; isArchived?: boolean; pushedAt?: string; defaultBranchRef?: { name: string; target?: Commit } | null;
  pullRequests?: { nodes: { number: number; title: string; headRefName: string; createdAt: string; isDraft: boolean; commits?: { nodes: { commit: Commit }[] } }[] };
  merged?: { nodes: { number: number; mergedAt: string; mergeCommit?: { oid: string } | null }[] };
  refs?: { nodes: { name: string; target?: Commit }[] };
}
interface Page { data?: { repositoryOwner?: { repositories?: { nodes: Repo[] } } }; errors?: { path?: (string | number)[] }[] }
export interface GhSnapshot { repo: string; at: string; last_push_at: string | null; last_commit_at: string | null; open_prs: string; default_ci: CI; stale_branches: string }
export interface Deploy { repo: string; at: string; sha: string; pr_number: number; source: 'merged PR' }
export function parseGitHub(raw: unknown, now: Date): { snapshots: GhSnapshot[]; deploys: Deploy[]; repos: Repo[] } {
  const pages = (Array.isArray(raw) ? raw : [raw]) as Page[];
  const snapshots: GhSnapshot[] = [], deploys: Deploy[] = [], repos: Repo[] = [];
  for (const page of pages) {
    const nodes = page.data?.repositoryOwner?.repositories?.nodes;
    if (!nodes) throw new Error('GitHub response has no repository data');
    nodes.forEach((repo, index) => {
      if (!repo) throw new Error('GitHub returned an incomplete repository');
      const error = !!page.errors?.some(e => !e.path || !e.path.includes('nodes') || e.path[e.path.indexOf('nodes') + 1] === index);
      const prs = (repo.pullRequests?.nodes ?? []).map(pr => ({ number: pr.number, title: redact(pr.title), branch: redact(pr.headRefName), created_at: pr.createdAt,
        age: Math.max(0, Math.floor((now.getTime() - Date.parse(pr.createdAt)) / 86_400_000)), is_draft: pr.isDraft, checks: ciState(pr.commits?.nodes[0]?.commit.statusCheckRollup, error) }));
      const stale = (repo.refs?.nodes ?? []).filter(ref => ref.name !== repo.defaultBranchRef?.name && ref.target?.committedDate && now.getTime() - Date.parse(ref.target.committedDate) > 14 * 86_400_000).map(ref => ({ name: redact(ref.name), committed_at: ref.target!.committedDate }));
      snapshots.push({ repo: repo.name, at: now.toISOString(), last_push_at: repo.pushedAt ?? null, last_commit_at: repo.defaultBranchRef?.target?.committedDate ?? null,
        open_prs: JSON.stringify(prs), default_ci: ciState(repo.defaultBranchRef?.target?.statusCheckRollup, error), stale_branches: JSON.stringify(stale) });
      for (const pr of repo.merged?.nodes ?? []) if (pr.mergeCommit && pr.mergedAt) deploys.push({ repo: repo.name, at: pr.mergedAt, sha: pr.mergeCommit.oid, pr_number: pr.number, source: 'merged PR' });
      repos.push(repo);
    });
  }
  return { snapshots, deploys, repos };
}
