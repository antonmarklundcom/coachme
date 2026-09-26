import type { Exec } from '../../lib/exec.js';
export const QUERY = `query($owner:String!,$cursor:String) {
 repositoryOwner(login:$owner) { repositories(first:25,after:$cursor,orderBy:{field:NAME,direction:ASC}) {
 pageInfo { hasNextPage endCursor }
 nodes { name isArchived pushedAt
 defaultBranchRef { name target { ... on Commit { committedDate statusCheckRollup { state } } } }
 pullRequests(first:20,states:OPEN,orderBy:{field:CREATED_AT,direction:DESC}) { nodes { number title headRefName createdAt isDraft commits(last:1) { nodes { commit { statusCheckRollup { state } } } } } }
 merged:pullRequests(last:10,states:MERGED,orderBy:{field:UPDATED_AT,direction:ASC}) { nodes { number mergedAt mergeCommit { oid } } }
 refs(refPrefix:"refs/heads/",first:50) { nodes { name target { ... on Commit { committedDate } } } }
 } } } }`;
export async function queryGitHub(exec: Exec, owner: string): Promise<unknown[]> {
  const pages: unknown[] = []; let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const page = JSON.parse(await exec('gh', args, { timeout: 15_000 }));
    if (!page.data?.repositoryOwner?.repositories) throw new Error('GitHub repository query failed');
    pages.push(page);
    const info = page.data.repositoryOwner.repositories.pageInfo;
    cursor = info.hasNextPage ? info.endCursor : null;
    if (info.hasNextPage && (!cursor || seen.has(cursor))) throw new Error('GitHub pagination did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return pages;
}
