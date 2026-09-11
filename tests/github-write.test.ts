/**
 * The write guard (plan.md Decision D-F, §4.16).
 *
 * coachme holds a token that can write to every repository Anton owns. What
 * makes that acceptable is not trust in the model — it is that this module can
 * only do three things, and these tests fail if that stops being true.
 *
 * Two kinds of assertion here, deliberately:
 *   - behavioural: the guards refuse what they are supposed to refuse;
 *   - structural: the SOURCE of lib/github/write.ts contains no delete, no
 *     force, no ref manipulation. A future phase that adds one fails the suite
 *     instead of passing review.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as write from '../lib/github/write';
import { isGreen, isPending, isRed, prState } from '../lib/github/checks';

const SOURCE = readFileSync(join(process.cwd(), 'lib', 'github', 'write.ts'), 'utf8');
/** Only the code, so the header comment explaining what is forbidden does not
 *  itself trip the structural checks. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the shape of the write surface', () => {
  it('exports exactly three write functions, two error types and two constants', () => {
    expect(Object.keys(write).sort()).toEqual([
      'GithubWriteRefused',
      'GithubWriteUnavailable',
      'MERGEABLE_BRANCH_PREFIXES',
      'PROMPT_PATH_PREFIX',
      'createIssue',
      'mergePull',
      'putPromptFile',
    ]);
  });

  it('has no delete, force-push or ref manipulation anywhere in its code', () => {
    for (const forbidden of ['DELETE', 'force', 'git/refs', 'PATCH', '/merges', 'workflows']) {
      expect(CODE, `write.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('issues only POST and PUT', () => {
    const methods = [...CODE.matchAll(/'(GET|POST|PUT|PATCH|DELETE)'/g)].map((m) => m[1]);
    expect([...new Set(methods)].sort()).toEqual(['POST', 'PUT']);
  });

  it('pins the path prefix and the mergeable branch prefixes', () => {
    expect(write.PROMPT_PATH_PREFIX).toBe('prompts/coachme/');
    expect([...write.MERGEABLE_BRANCH_PREFIXES]).toEqual(['coachme/', 'claude/', 'codex/']);
  });
});

/* --------------------------------------------------------------- behaviour */

const originalToken = process.env.GITHUB_TOKEN;

function mockGithub(routes: Record<string, unknown>, onWrite?: (url: string, init: RequestInit) => void) {
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    const path = String(url).replace('https://api.github.com', '').split('?')[0];
    if (init.method === 'PUT' || init.method === 'POST') onWrite?.(path, init);
    const key = `${init.method ?? 'GET'} ${path}`;
    const body = routes[key] ?? routes[path];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: '[coachme:add-stripe] Add Stripe',
  state: 'open',
  merged: false,
  draft: false,
  mergeable_state: 'clean',
  merged_at: null,
  updated_at: '2026-09-11T00:00:00Z',
  html_url: 'https://github.com/antonmarklundcom/besikt/pull/7',
  head: { ref: 'coachme/add-stripe', sha: 'abc123' },
  base: { ref: 'main' },
  ...over,
});

describe('putPromptFile', () => {
  it('writes only under prompts/coachme/, with a path it derives itself', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    let written: { path: string; body: Record<string, unknown> } | null = null;
    mockGithub(
      {
        '/repos/antonmarklundcom/besikt': { default_branch: 'main', name: 'besikt' },
        'PUT /repos/antonmarklundcom/besikt/contents/prompts/coachme/add-stripe.md': {
          commit: { sha: 'deadbeef' },
        },
      },
      (path, init) => {
        written = { path, body: JSON.parse(String(init.body)) };
      }
    );

    const result = await write.putPromptFile('antonmarklundcom/besikt', 'add-stripe', '# prompt');
    expect(result).toMatchObject({ path: 'prompts/coachme/add-stripe.md', branch: 'main', commit_sha: 'deadbeef' });
    expect(written!.path).toBe('/repos/antonmarklundcom/besikt/contents/prompts/coachme/add-stripe.md');
    expect(written!.body.message).toBe('coachme: dispatch add-stripe');
    expect(Buffer.from(String(written!.body.content), 'base64').toString()).toBe('# prompt');
  });

  it('refuses an empty prompt before it touches the network', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    vi.stubGlobal('fetch', async () => {
      throw new Error('the network must not be reached');
    });
    await expect(write.putPromptFile('a/b', 'slug', '   ')).rejects.toBeInstanceOf(write.GithubWriteRefused);
  });

  it('reports a missing token as unavailable, so dispatch can fall back to copy', async () => {
    delete process.env.GITHUB_TOKEN;
    mockGithub({ '/repos/a/b': { default_branch: 'main' } });
    await expect(write.putPromptFile('a/b', 'slug', 'body')).rejects.toBeInstanceOf(write.GithubWriteUnavailable);
  });
});

describe('mergePull', () => {
  it('merges a green coachme branch, squashed', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    let method: string | null = null;
    mockGithub(
      {
        '/repos/antonmarklundcom/besikt/pulls/7': pull(),
        '/repos/antonmarklundcom/besikt/commits/abc123/check-runs': {
          check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
        },
        '/repos/antonmarklundcom/besikt/commits/abc123/status': { statuses: [] },
        'PUT /repos/antonmarklundcom/besikt/pulls/7/merge': { merged: true, sha: 'merged1' },
      },
      (_path, init) => {
        method = JSON.parse(String(init.body)).merge_method;
      }
    );

    await expect(write.mergePull('antonmarklundcom/besikt', 7)).resolves.toEqual({ merged: true, sha: 'merged1' });
    expect(method).toBe('squash');
  });

  it('refuses a branch outside the allowed prefixes', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockGithub({ '/repos/a/b/pulls/7': pull({ head: { ref: 'feature/whatever', sha: 'abc123' } }) });
    await expect(write.mergePull('a/b', 7)).rejects.toThrow(/only coachme\/, claude\/, codex\//);
  });

  it('refuses a red PR, a conflicted one, and one already merged', async () => {
    process.env.GITHUB_TOKEN = 'test-token';

    mockGithub({
      '/repos/a/b/pulls/7': pull(),
      '/repos/a/b/commits/abc123/check-runs': {
        check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      },
      '/repos/a/b/commits/abc123/status': { statuses: [] },
    });
    await expect(write.mergePull('a/b', 7)).rejects.toThrow(/not green/);

    mockGithub({ '/repos/a/b/pulls/7': pull({ mergeable_state: 'dirty' }) });
    await expect(write.mergePull('a/b', 7)).rejects.toThrow(/conflicts/);

    mockGithub({ '/repos/a/b/pulls/7': pull({ merged: true, state: 'closed' }) });
    await expect(write.mergePull('a/b', 7)).rejects.toThrow(/already merged/);
  });

  it('refuses to merge when GitHub will not say what the checks are', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    // No checks routes at all: both CI endpoints 404. An empty answer and a
    // silent one must not look the same to the guard.
    mockGithub({
      '/repos/a/b/pulls/7': pull(),
      'PUT /repos/a/b/pulls/7/merge': { merged: true, sha: 'nope' },
    });
    await expect(write.mergePull('a/b', 7)).rejects.toThrow(/did not answer about its checks/);
  });

  it('refuses a PR that is still running its checks', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockGithub({
      '/repos/a/b/pulls/7': pull(),
      '/repos/a/b/commits/abc123/check-runs': {
        check_runs: [{ name: 'build', status: 'in_progress', conclusion: null }],
      },
      '/repos/a/b/commits/abc123/status': { statuses: [] },
    });
    await expect(write.mergePull('a/b', 7)).rejects.toThrow(/not green/);
  });
});

describe('check reading', () => {
  const none = { runs: [], statuses: [], unknown: false };

  it('treats a repo with no CI as green — most of the portfolio has none', () => {
    expect(isGreen(none)).toBe(true);
    expect(isRed(none)).toBe(false);
    expect(isPending(none)).toBe(false);
  });

  it('is never green when the checks API did not answer', () => {
    expect(isGreen({ runs: [], statuses: [], unknown: true })).toBe(false);
    expect(prState(pull(), { runs: [], statuses: [], unknown: true })).toBe('open');
  });

  it('lets neutral and skipped runs pass, but nothing else', () => {
    expect(isGreen({ runs: [{ name: 'a', status: 'completed', conclusion: 'skipped' }], statuses: [] })).toBe(true);
    expect(isGreen({ runs: [{ name: 'a', status: 'completed', conclusion: 'timed_out' }], statuses: [] })).toBe(false);
  });

  it('reads a commit status as well as a check run', () => {
    expect(isRed({ runs: [], statuses: [{ state: 'failure', context: 'vercel' }] })).toBe(true);
    expect(isPending({ runs: [], statuses: [{ state: 'pending', context: 'vercel' }] })).toBe(true);
  });

  it('maps a PR to the state the Merge button reads', () => {
    expect(prState(pull(), none)).toBe('green');
    expect(prState(pull({ merged: true }), none)).toBe('merged');
    expect(prState(pull({ mergeable_state: 'dirty' }), none)).toBe('conflict');
    expect(prState(pull({ draft: true }), none)).toBe('open');
    expect(prState(pull(), { runs: [{ name: 'a', status: 'completed', conclusion: 'failure' }], statuses: [] })).toBe('red');
    // A conflict outranks green: it is not mergeable, whatever CI says.
    expect(prState(pull({ mergeable_state: 'dirty' }), none)).toBe('conflict');
  });
});
