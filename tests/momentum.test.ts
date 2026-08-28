/**
 * The momentum strip (DESIGN.md §2.6), ported from
 * scripts/legacy/src/scope.js onto NudgeRecord rows.
 */

import { describe, expect, it } from 'vitest';
import type { Repo } from '../lib/domain';
import type { NudgeRecord } from '../lib/nudge/history';
import { momentum, streakDays } from '../lib/momentum';

function repo(partial: Partial<Repo> & { name: string }): Repo {
  return {
    id: Math.floor(Math.random() * 1e6),
    github_full_name: `antonmarklundcom/${partial.name}`,
    pct: 0,
    lane: 'early-open',
    blocker: 'none',
    tier: 'experiment',
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
  };
}

function nudge(partial: Partial<NudgeRecord> & { local_date: string }): NudgeRecord {
  return {
    id: Math.floor(Math.random() * 1e6),
    type: 'db-session',
    repo_names: [],
    outcome: 'pending',
    pushed: true,
    shrunk: false,
    parent_type: null,
    title: null,
    body: null,
    note: null,
    ...partial,
  };
}

describe('streakDays', () => {
  it('is 0 with no history', () => {
    expect(streakDays([], '2026-08-28')).toBe(0);
  });

  it('counts from the first ever nudge when nothing was ignored', () => {
    const history = [nudge({ local_date: '2026-08-20', outcome: 'acted' })];
    expect(streakDays(history, '2026-08-28')).toBe(8);
  });

  it('resets to the most recent ignored ask, not the first nudge', () => {
    const history = [
      nudge({ local_date: '2026-08-01', outcome: 'acted' }),
      nudge({ local_date: '2026-08-20', outcome: 'ignored' }),
      nudge({ local_date: '2026-08-24', outcome: 'acted' }),
    ];
    expect(streakDays(history, '2026-08-28')).toBe(8);
  });

  it('ignores history after the given date', () => {
    const history = [nudge({ local_date: '2026-08-30', outcome: 'ignored' })];
    expect(streakDays(history, '2026-08-28')).toBe(0);
  });
});

describe('momentum', () => {
  it('counts launches within the trailing 31 days, not before or after', () => {
    const repos = [
      repo({ name: 'in-window', launched_at: '2026-08-10' }),
      repo({ name: 'too-old', launched_at: '2026-07-01' }),
      repo({ name: 'future', launched_at: '2026-09-01' }),
      repo({ name: 'never-launched' }),
    ];
    const strip = momentum(repos, [], { date: '2026-08-28' });
    expect(strip.launches).toBe(1);
    expect(strip.launch_names).toEqual(['in-window']);
  });

  it('counts only acted db-session nudges as sessions', () => {
    const history = [
      nudge({ local_date: '2026-08-01', type: 'db-session', outcome: 'acted' }),
      nudge({ local_date: '2026-08-02', type: 'db-session', outcome: 'ignored' }),
      nudge({ local_date: '2026-08-03', type: 'scope-review', outcome: 'acted' }),
    ];
    expect(momentum([], history, { date: '2026-08-28' }).sessions).toBe(1);
  });

  it('defaults the baseline to the current remaining minutes, so a fresh run starts at 0% burned', () => {
    const repos = [repo({ name: 'a', blocker: 'db-setup', pct: 90 })];
    const strip = momentum(repos, [], { date: '2026-08-28' });
    expect(strip.baseline_minutes).toBe(strip.remaining_minutes);
    expect(strip.burned_pct).toBe(0);
  });

  it('burns down against a fixed baseline as DB work clears', () => {
    const repos = [repo({ name: 'a', blocker: 'none', pct: 90 })]; // nothing left to do
    const strip = momentum(repos, [], { date: '2026-08-28', baselineMinutes: 360 });
    expect(strip.remaining_minutes).toBe(0);
    expect(strip.burned_pct).toBe(100);
  });

  it('treats a 0 baseline the same as unset, not a divide-by-zero', () => {
    const strip = momentum([], [], { date: '2026-08-28', baselineMinutes: 0 });
    expect(strip.burned_pct).toBe(0);
  });

  it('sums owner-minutes only across live, owner-blocked repos', () => {
    const repos = [
      repo({ name: 'blocked', blocker: 'db-setup' }), // 20
      repo({ name: 'agent', blocker: 'sibling' }), // agent-side, excluded
      repo({ name: 'killed', blocker: 'db-setup', killed_at: '2026-08-01' }), // dormant, excluded
    ];
    expect(momentum(repos, [], { date: '2026-08-28' }).owner_minutes_total).toBe(20);
  });
});
