/**
 * Dispatch, PR linking, the two digest rungs and the Monday report.
 *
 * The database and GitHub are both mocked here: what is being tested is the
 * decision-making — who may be dispatched, which PR belongs to which item, when
 * the coach is allowed to speak — not the SQL or the HTTP, which the write-guard
 * tests and a real scan cover respectively.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo, WorkItem } from '../lib/domain';
import { linkPulls, matches, titleMarker } from '../lib/scan/link';
import { digestBody, NO_WORK, selectNudge, type LadderInput } from '../lib/nudge/ladder';
import { buildWeeklyReport } from '../lib/report/weekly';
import { collectWork } from '../lib/nudge/run';

/* ------------------------------------------------------------- fixtures */

function repo(partial: Partial<Repo> & { name: string; id: number }): Repo {
  return {
    github_full_name: `antonmarklundcom/${partial.name}`,
    pct: 50,
    lane: 'early-open',
    blocker: 'none',
    tier: 'revenue',
    hostinger_account: null,
    market: null,
    next_step: null,
    open_prs: 0,
    merged_prs_30d: 0,
    live_url: null,
    live_url_ok: null,
    launched_at: null,
    unblocks: [],
    depends_on: [],
    related: [],
    unblocks_revenue: null,
    notes: null,
    stage: 'building',
    revenue_model: 'unknown',
    price_note: null,
    currency: null,
    payment_rail: null,
    channel: null,
    sell_url: null,
    first_revenue_at: null,
    revenue_30d: null,
    stage_evidence: [],
    cleared_blockers: [],
    snoozed_until: null,
    scope_review_due: false,
    scope_review_proposed: null,
    scope_reviews_unanswered: 0,
    kept_at: null,
    killed_at: null,
    last_commit_at: null,
    pushed_at: null,
    last_scan_at: null,
    last_scan_head_sha: null,
    blocked_scans: 0,
    newly_blocked_at: null,
    ...partial,
  } as Repo;
}

function item(partial: Partial<WorkItem> & { id: number; slug: string; repo_id: number }): WorkItem {
  return {
    title: partial.slug,
    kind: 'agent',
    tool: 'either',
    model: 'sonnet',
    stage_target: 'live',
    prompt_md: '# prompt',
    one_liner: `Read prompts/coachme/${partial.slug}.md in this repo and execute it.`,
    estimate_minutes: null,
    status: 'proposed',
    source: 'generator',
    branch: null,
    pr_url: null,
    pr_number: null,
    pr_state: null,
    note: null,
    dispatched_at: null,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    ...partial,
  } as WorkItem;
}

const pull = (over: Record<string, unknown> = {}) =>
  ({
    number: 7,
    title: 'Some change',
    state: 'open',
    merged: false,
    draft: false,
    mergeable_state: 'clean',
    merged_at: null,
    updated_at: '2026-09-11T00:00:00Z',
    html_url: 'https://github.com/x/y/pull/7',
    head: { ref: 'coachme/add-stripe', sha: 'abc' },
    base: { ref: 'main' },
    ...over,
  }) as never;

/* --------------------------------------------------------------- linking */

describe('linking a PR back to the work that asked for it', () => {
  const stripe = { slug: 'add-stripe' };

  it('links by the head branch the prompt header named', () => {
    expect(matches(stripe, pull())).toBe(true);
  });

  it('links by the PR title marker when the branch was renamed', () => {
    expect(matches(stripe, pull({ head: { ref: 'fix/stripe', sha: 'abc' }, title: `${titleMarker('add-stripe')} Add Stripe` }))).toBe(true);
  });

  it('never links a bare claude/* branch — Anton opens those all the time', () => {
    expect(matches(stripe, pull({ head: { ref: 'claude/whatever', sha: 'abc' }, title: 'Unrelated work' }))).toBe(false);
  });

  it('does not link one item to another item\'s PR', () => {
    expect(matches({ slug: 'add-swish' }, pull())).toBe(false);
  });

  it('prefers the open PR when an earlier attempt was closed', () => {
    const closed = pull({ number: 5, state: 'closed', updated_at: '2026-09-12T00:00:00Z' });
    const open = pull({ number: 9, state: 'open', updated_at: '2026-09-09T00:00:00Z' });
    expect(linkPulls([{ id: 1, ...stripe }], [closed, open])[0].pull.number).toBe(9);
  });

  it('finds the merged one when nothing is open', () => {
    const merged = pull({ number: 5, state: 'closed', merged: true });
    expect(linkPulls([{ id: 1, ...stripe }], [merged])[0].pull.number).toBe(5);
  });
});

/* ------------------------------------------------------------ the digest */

describe('the digest line', () => {
  it('reads the way Decision D-J writes it', () => {
    expect(
      digestBody({
        green: [
          { repo: 'besikt', slug: 'a', title: 'A' },
          { repo: 'gruas', slug: 'b', title: 'B' },
        ],
        proposed: [{ repo: 'besikt', slug: 'c', title: 'C' }],
        ownerStep: { repo: 'besikt', slug: 'd', title: 'create the Neon DB', minutes: 20 },
      })
    ).toBe('2 PRs green · approve 1 item · owner: create the Neon DB (20 min)');
  });

  it('leaves out what is not there rather than writing zeroes', () => {
    expect(digestBody({ ...NO_WORK, green: [{ repo: 'x', slug: 'a', title: 'A' }] })).toBe('1 PR green');
    expect(digestBody(NO_WORK)).toBe('');
  });
});

describe('the two new rungs', () => {
  const base = (over: Partial<LadderInput> = {}): LadderInput => ({
    date: '2026-09-15', // a Tuesday
    repos: [repo({ id: 1, name: 'besikt', stage: 'live', pct: 90 })],
    history: [],
    session: {},
    pendingDecisions: [],
    verifyItems: [],
    ...over,
  });

  it('asks for a merge before anything else on the ladder', () => {
    const decision = selectNudge(
      base({ work: { ...NO_WORK, green: [{ repo: 'besikt', slug: 'a', title: 'A' }] } })
    );
    expect(decision).toMatchObject({ push: true, type: 'merge-prs', repos: ['besikt'] });
    expect(decision.title).toBe('1 PR ready to merge');
  });

  it('asks for the owner step only when there is nothing to merge', () => {
    const work = {
      green: [{ repo: 'besikt', slug: 'a', title: 'A' }],
      proposed: [],
      ownerStep: { repo: 'besikt', slug: 'b', title: 'create the DB', minutes: 20 },
    };
    expect(selectNudge(base({ work })).type).toBe('merge-prs');
    expect(selectNudge(base({ work: { ...work, green: [] } })).type).toBe('owner-step');
  });

  it('never pushes for proposals alone — that is the nagging v3 removes', () => {
    const decision = selectNudge(
      base({ work: { ...NO_WORK, proposed: [{ repo: 'besikt', slug: 'a', title: 'A' }] } })
    );
    expect(decision.type).not.toBe('merge-prs');
    expect(decision.type).not.toBe('owner-step');
  });

  it('still obeys every v2 cap: Sunday stays silent even with green PRs', () => {
    const decision = selectNudge(
      base({ date: '2026-09-13', work: { ...NO_WORK, green: [{ repo: 'besikt', slug: 'a', title: 'A' }] } })
    );
    expect(decision).toMatchObject({ push: false, type: null });
  });

  it('stays silent once the day is already decided', () => {
    const history = [
      {
        id: 1,
        local_date: '2026-09-15',
        type: 'db-session' as const,
        repo_names: [],
        outcome: 'pending' as const,
        pushed: true,
        shrunk: false,
        parent_type: null,
        title: null,
        body: null,
        note: null,
      },
    ];
    expect(
      selectNudge(base({ history, work: { ...NO_WORK, green: [{ repo: 'besikt', slug: 'a', title: 'A' }] } })).push
    ).toBe(false);
  });

  it('behaves exactly as v2 did when there is no launch desk at all', () => {
    expect(selectNudge(base()).type).toBe(selectNudge(base({ work: NO_WORK })).type);
  });
});

/* ------------------------------------------------------- what the desk has */

describe('collectWork', () => {
  const repos = [
    repo({ id: 1, name: 'far', stage: 'building', pct: 10 }),
    repo({ id: 2, name: 'near', stage: 'live', pct: 80 }),
  ];

  it('takes the owner step from the repo closest to money, not the oldest item', () => {
    const items = [
      item({ id: 1, slug: 'far-step', repo_id: 1, kind: 'owner', status: 'approved', estimate_minutes: 5 }),
      item({ id: 2, slug: 'near-step', repo_id: 2, kind: 'owner', status: 'approved', estimate_minutes: 20 }),
    ];
    expect(collectWork(repos, items, '2026-09-15').ownerStep).toMatchObject({ repo: 'near', slug: 'near-step' });
  });

  it('prefers an approved step over an unapproved one on the same repo', () => {
    const items = [
      item({ id: 1, slug: 'proposed-step', repo_id: 2, kind: 'owner', status: 'proposed' }),
      item({ id: 2, slug: 'approved-step', repo_id: 2, kind: 'owner', status: 'approved' }),
    ];
    expect(collectWork(repos, items, '2026-09-15').ownerStep?.slug).toBe('approved-step');
  });

  it('counts only green PRs as mergeable', () => {
    const items = [
      item({ id: 1, slug: 'a', repo_id: 2, status: 'pr_open', pr_state: 'green' }),
      item({ id: 2, slug: 'b', repo_id: 2, status: 'pr_open', pr_state: 'red' }),
      item({ id: 3, slug: 'c', repo_id: 2, status: 'pr_open', pr_state: null }),
    ];
    expect(collectWork(repos, items, '2026-09-15').green.map((g) => g.slug)).toEqual(['a']);
  });
});

/* --------------------------------------------------------- weekly report */

describe('the Monday money report', () => {
  const repos = [
    repo({
      id: 1,
      name: 'near',
      stage: 'live',
      pct: 80,
      stage_evidence: [
        { stage: 'building', evidence: 'seeded', at: '2026-08-01', source: 'seed' },
        { stage: 'live', evidence: 'https://near.py answers', at: '2026-09-12', source: 'scan' },
      ],
    }),
    repo({ id: 2, name: 'far', stage: 'building', pct: 20 }),
    repo({ id: 3, name: 'coachme', stage: 'live', pct: 95, tier: 'infra', revenue_model: 'internal' }),
  ];
  const items = [
    item({ id: 1, slug: 'shipped-thing', repo_id: 1, status: 'merged', updated_at: '2026-09-14T00:00:00Z' }),
    item({ id: 2, slug: 'old-thing', repo_id: 1, status: 'merged', updated_at: '2026-08-01T00:00:00Z' }),
    item({ id: 3, slug: 'near-step', repo_id: 1, kind: 'owner', status: 'approved', estimate_minutes: 20 }),
  ];
  const report = buildWeeklyReport({ date: '2026-09-15', repos, items });

  it('ranks by distance to money and leaves the internal tools out', () => {
    expect(report.closest.map((c) => c.repo)).toEqual(['near', 'far']);
    expect(report.closest[0]).toMatchObject({ stage: 'live', distance: 320 });
  });

  it('reports the stage changes of the last week, and not the seed', () => {
    expect(report.stage_changes).toEqual([
      { repo: 'near', stage: 'live', evidence: 'https://near.py answers', at: '2026-09-12', source: 'scan' },
    ]);
  });

  it('reports only what shipped this week', () => {
    expect(report.shipped.map((s) => s.slug)).toEqual(['shipped-thing']);
  });

  it('names one owner step: the one on the nearest repo', () => {
    expect(report.owner_step).toMatchObject({ repo: 'near', slug: 'near-step', minutes: 20 });
  });

  it('counts the portfolio the way the home page shows it', () => {
    expect(report.totals).toMatchObject({ repos: 3, live_or_better: 2, earning: 0 });
  });
});

/* ------------------------------------------------------------- dispatch */

const state: { items: WorkItem[]; dispatches: unknown[]; repos: Repo[] } = {
  items: [],
  dispatches: [],
  repos: [],
};

vi.mock('../lib/queries', () => ({
  getWorkItem: async (id: number) => state.items.find((i) => i.id === id) ?? null,
  getRepoById: async (id: number) => state.repos.find((r) => r.id === id) ?? null,
  recordDispatch: async (workItemId: number, target: string, result: unknown) => {
    state.dispatches.push({ workItemId, target, result });
    return { id: state.dispatches.length };
  },
  updateWorkItem: async (id: number, patch: Record<string, unknown>) => {
    const target = state.items.find((i) => i.id === id)!;
    Object.assign(target, patch);
  },
  setWorkItemStatus: async (id: number, status: string) => {
    const target = state.items.find((i) => i.id === id)!;
    target.status = status as WorkItem['status'];
    return target;
  },
}));

const writeCalls: string[] = [];
vi.mock('../lib/github/write', async () => {
  const actual = await vi.importActual<typeof import('../lib/github/write')>('../lib/github/write');
  return {
    ...actual,
    putPromptFile: async () => {
      writeCalls.push('putPromptFile');
      if (!process.env.GITHUB_TOKEN) throw new actual.GithubWriteUnavailable('GITHUB_TOKEN is not set');
      return { path: 'prompts/coachme/a.md', branch: 'main', commit_sha: 'sha1', updated: false };
    },
    createIssue: async () => {
      writeCalls.push('createIssue');
      return { issue_url: 'https://github.com/x/y/issues/3', number: 3 };
    },
  };
});

describe('dispatching one approved item', () => {
  beforeEach(() => {
    state.repos = [repo({ id: 1, name: 'besikt' })];
    state.items = [
      item({ id: 1, slug: 'add-stripe', repo_id: 1, status: 'approved' }),
      item({ id: 2, slug: 'call-hostinger', repo_id: 1, kind: 'owner', tool: 'owner', status: 'approved' }),
      item({ id: 3, slug: 'not-yet', repo_id: 1, status: 'proposed' }),
    ];
    state.dispatches = [];
    writeCalls.length = 0;
    delete process.env.GITHUB_TOKEN;
  });

  it('refuses anything Anton has not approved', async () => {
    const { dispatch } = await import('../lib/dispatch/run');
    await expect(dispatch(3, 'copy')).rejects.toThrow(/only an approved item/);
    expect(writeCalls).toEqual([]);
  });

  it('refuses to commit an owner step into a repository', async () => {
    const { dispatch } = await import('../lib/dispatch/run');
    await expect(dispatch(2, 'repo-file')).rejects.toThrow(/owner step/);
    expect(writeCalls).toEqual([]);
  });

  it('dispatches by copy with no token at all, which is the day-one path', async () => {
    const { dispatch } = await import('../lib/dispatch/run');
    const result = await dispatch(1, 'copy');
    expect(writeCalls).toEqual([]);
    expect(result.target).toBe('copy');
    expect(result.one_liner).toBe('Read prompts/coachme/add-stripe.md in this repo and execute it.');
    expect(result.item.status).toBe('dispatched');
    expect(state.dispatches).toHaveLength(1);
  });

  it('falls back to copy when the token cannot write, and says so', async () => {
    const { dispatch } = await import('../lib/dispatch/run');
    const result = await dispatch(1, 'repo-file');
    expect(writeCalls).toEqual(['putPromptFile']);
    expect(result.target).toBe('copy');
    expect(result.degraded).toMatch(/GITHUB_TOKEN is not set/);
    expect(result.item.status).toBe('dispatched');
  });

  it('commits the prompt file when the token can write', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const { dispatch } = await import('../lib/dispatch/run');
    const result = await dispatch(1, 'repo-file');
    expect(result).toMatchObject({ target: 'repo-file', commit_sha: 'sha1', degraded: null });
    expect(result.item.branch).toBe('coachme/add-stripe');
  });

  it('opens an issue with the PR-title marker in its title', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const { dispatch } = await import('../lib/dispatch/run');
    const result = await dispatch(1, 'issue');
    expect(result.issue_url).toBe('https://github.com/x/y/issues/3');
    expect(writeCalls).toEqual(['createIssue']);
  });
});
