/**
 * github/write.ts — everything this app is able to do to another repository.
 *
 * This module is the reason a fine-grained PAT with write access to 61
 * repositories is an acceptable thing for a personal coach to hold. Read it as
 * a capability list, because that is what it is (plan.md Decision D-F, §4.16):
 *
 *   putPromptFile  commit ONE file, at a path this module computes itself from
 *                  a slug, always under `prompts/coachme/`, on the default
 *                  branch. Create or update. Nothing else, nowhere else.
 *   createIssue    open an issue with the same body.
 *   mergePull      squash-merge a pull request whose head branch starts with
 *                  `coachme/`, `claude/` or `codex/`, and only when it is green
 *                  and conflict-free.
 *
 * There is no fourth function, and these three are the whole surface. There is
 * deliberately NO delete, NO force, NO ref manipulation, NO workflow dispatch,
 * NO settings change, NO release, NO branch creation. tests/github-write.test.ts
 * asserts the absence of those verbs in this file's source text, so adding one
 * fails the suite rather than passing review — the guard is meant to be
 * annoying to get around, since a future phase is forbidden from widening it
 * (plan.md §4.16).
 *
 * Every function refuses loudly (`GithubWriteRefused`) rather than degrading:
 * a guard that silently does nothing is a guard nobody notices is broken.
 */

import { promptPathFor } from '../domain';
import { getChecks, getFileSha, getPull, getRepoInfo, githubToken } from '../scan/github';
import { isGreen } from './checks';

const API = 'https://api.github.com';

/** Branch prefixes a merge is allowed to touch: ours, and the two agents'. */
export const MERGEABLE_BRANCH_PREFIXES = ['coachme/', 'claude/', 'codex/'] as const;

/** The only path prefix this app may ever write to in another repository. */
export const PROMPT_PATH_PREFIX = 'prompts/coachme/';

/** No token, or a read-only one: the caller falls back to the `copy` target. */
export class GithubWriteUnavailable extends Error {}

/** A guard said no. Never caught and ignored — it means a bug or an attack. */
export class GithubWriteRefused extends Error {}

async function write<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  const token = githubToken();
  if (!token) throw new GithubWriteUnavailable('GITHUB_TOKEN is not set');

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'coachme-dispatch',
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (res.status === 401 || res.status === 403) {
    throw new GithubWriteUnavailable(`GitHub ${res.status}: the token cannot write here`);
  }
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/* ---------------------------------------------------------------- the three */

export interface PutPromptFileResult {
  path: string;
  branch: string;
  commit_sha: string;
  updated: boolean;
}

/**
 * Commit `prompts/coachme/<slug>.md` on the target repo's default branch.
 *
 * The path is DERIVED from the slug rather than accepted from the caller, which
 * is a stronger guarantee than validating one: there is no string a caller can
 * pass that escapes the directory. The prefix check that follows is redundant
 * on purpose — it is what the test pins, so the derivation can never quietly be
 * replaced by a parameter.
 */
export async function putPromptFile(
  fullName: string,
  slug: string,
  body: string,
  { message }: { message?: string } = {}
): Promise<PutPromptFileResult> {
  const path = promptPathFor(slug);
  if (!path.startsWith(PROMPT_PATH_PREFIX) || path.includes('..') || !path.endsWith('.md')) {
    throw new GithubWriteRefused(`refusing to write "${path}": outside ${PROMPT_PATH_PREFIX}`);
  }
  if (!body.trim()) throw new GithubWriteRefused('refusing to commit an empty prompt');

  const info = await getRepoInfo(fullName);
  if (!info) throw new GithubWriteRefused(`repo "${fullName}" is not reachable`);
  const branch = info.default_branch;

  const sha = await getFileSha(fullName, path, branch);
  const result = await write<{ commit: { sha: string } }>(
    `/repos/${fullName}/contents/${encodeURI(path)}`,
    'PUT',
    {
      message: message ?? `coachme: dispatch ${slug}`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }
  );

  return { path, branch, commit_sha: result.commit.sha, updated: !!sha };
}

export async function createIssue(
  fullName: string,
  title: string,
  body: string
): Promise<{ issue_url: string; number: number }> {
  if (!title.trim()) throw new GithubWriteRefused('refusing to open an untitled issue');
  const issue = await write<{ html_url: string; number: number }>(`/repos/${fullName}/issues`, 'POST', {
    title,
    body,
  });
  return { issue_url: issue.html_url, number: issue.number };
}

/**
 * Squash-merge a pull request. Three guards, all of which must pass:
 *
 *   1. the head branch starts with an allowed prefix — so this can never merge
 *      someone's unrelated feature branch, nor a PR from a fork;
 *   2. the PR is open and not conflicted;
 *   3. every check on the head commit has finished and none of them failed
 *      (lib/github/checks.ts; a repo with no CI at all counts as green, see
 *      that file's header).
 */
export async function mergePull(
  fullName: string,
  number: number
): Promise<{ merged: boolean; sha: string }> {
  const pull = await getPull(fullName, number);
  if (!pull) throw new GithubWriteRefused(`${fullName}#${number} does not exist`);

  const branch = pull.head.ref;
  if (!MERGEABLE_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    throw new GithubWriteRefused(
      `refusing to merge "${branch}": only ${MERGEABLE_BRANCH_PREFIXES.join(', ')} branches`
    );
  }
  if (pull.merged) throw new GithubWriteRefused(`${fullName}#${number} is already merged`);
  if (pull.state !== 'open') throw new GithubWriteRefused(`${fullName}#${number} is not open`);
  if (pull.mergeable_state === 'dirty') {
    throw new GithubWriteRefused(`${fullName}#${number} has conflicts — resolve them first`);
  }

  const checks = await getChecks(fullName, pull.head.sha);
  if (checks.unknown) {
    throw new GithubWriteRefused(
      `${fullName}#${number}: GitHub did not answer about its checks — refusing to merge blind`
    );
  }
  if (!isGreen(checks)) {
    throw new GithubWriteRefused(`${fullName}#${number} is not green — refusing to merge`);
  }

  const result = await write<{ merged: boolean; sha: string }>(
    `/repos/${fullName}/pulls/${number}/merge`,
    'PUT',
    { merge_method: 'squash' }
  );
  return { merged: !!result.merged, sha: result.sha };
}
