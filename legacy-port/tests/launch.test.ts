/**
 * The launch model: what raises a stage, and what a work item may become.
 *
 * These two files are the guard rails on a loop that runs unattended against 61
 * repositories, so the tests are mostly about what must NOT happen: no raise
 * without evidence, no more than one rung per run, no lowering, and no path
 * from a proposed item to a dispatched one that skips Anton's tick.
 */

import { describe, expect, it } from 'vitest';
import type { Repo } from '../lib/domain';
import { STAGES, stageGap, toSlug, isSlug, oneLinerFor, branchFor } from '../lib/domain';
import { claims, proposeStage, seedStage, supportedStage, withEvidence } from '../lib/launch/stage';
import {
  IllegalTransition,
  assertTransition,
  canTransition,
  isInFlight,
  statusFromGithub,
} from '../lib/launch/items';

function repo(partial: Partial<Repo> & { name: string }): Repo {
  return {
    id: 1,
    github_full_name: `antonmarklundcom/${partial.name}`,
    pct: 0,
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

describe('stage vocabulary', () => {
  it('orders the road from building to earning', () => {
    expect(stageGap('earning')).toBe(0);
    expect(stageGap('building')).toBe(STAGES.length - 1);
    expect(stageGap('live')).toBeLessThan(stageGap('deployable'));
  });

  it('treats an unknown stage as the furthest away rather than the closest', () => {
    expect(stageGap('nonsense')).toBe(stageGap('building'));
  });
});

describe('stage evidence', () => {
  it('claims deployable on a green build, whatever the recorded percentage says', () => {
    const r = repo({ name: 'besikt', pct: 40 });
    expect(claims(r, { build_green: true })).toEqual([
      { stage: 'deployable', evidence: 'CI is green on the default branch' },
    ]);
  });

  it('claims deployable at 90% only when the blocker does not contradict it', () => {
    const r = repo({ name: 'besikt', pct: 95, blocker: 'db-setup' });
    expect(supportedStage(r)?.stage).toBe('deployable');
    expect(supportedStage(repo({ name: 'x', pct: 95, blocker: 'scope-undefined' }))).toBeNull();
  });

  it('claims live only from a URL that actually answered', () => {
    const r = repo({ name: 'trabajo', pct: 92, live_url: 'https://trabajo.com.py' });
    expect(supportedStage(r, { live_url_ok: true })?.stage).toBe('live');
    expect(supportedStage(r, { live_url_ok: false })?.stage).toBe('deployable');
  });

  it('never claims marketed automatically — nothing fetchable proves it', () => {
    const r = repo({ name: 'x', pct: 100, live_url_ok: true, payment_rail: 'stripe' });
    expect(claims(r).map((c) => c.stage)).not.toContain('marketed');
  });

  it('claims earning from recorded first revenue', () => {
    const r = repo({ name: 'x', pct: 100, first_revenue_at: '2026-09-01' });
    expect(supportedStage(r)?.stage).toBe('earning');
  });
});

describe('proposeStage', () => {
  it('raises by at most one rung per run, and says the cap held it back', () => {
    const r = repo({ name: 'x', pct: 100, first_revenue_at: '2026-09-01' });
    const claim = proposeStage(r)!;
    expect(claim.stage).toBe('deployable');
    expect(claim.evidence).toMatch(/capped at one stage per run/);
  });

  it('never lowers a stage, even when the evidence disappeared', () => {
    const r = repo({ name: 'x', stage: 'live', pct: 20, live_url: 'https://x.py' });
    expect(proposeStage(r, { live_url_ok: false })).toBeNull();
  });

  it('returns null when there is no evidence at all', () => {
    expect(proposeStage(repo({ name: 'x', pct: 10 }))).toBeNull();
  });

  it('appends evidence rather than replacing it', () => {
    const r = repo({ name: 'x', stage_evidence: [{ stage: 'building', evidence: 'seeded', at: '2026-09-01', source: 'seed' }] });
    const next = withEvidence(r, { stage: 'deployable', evidence: 'CI is green' }, 'scan', '2026-09-11');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ stage: 'deployable', evidence: 'CI is green', at: '2026-09-11', source: 'scan' });
  });

  it('seeds from the baseline audit the way plan.md §5 O3 says', () => {
    expect(seedStage({ live_url_ok: true, pct: 10 })).toBe('live');
    expect(seedStage({ live_url_ok: null, pct: 90 })).toBe('deployable');
    expect(seedStage({ live_url_ok: null, pct: 89 })).toBe('building');
  });
});

describe('work item transitions', () => {
  it('requires the approval tick before anything can be dispatched', () => {
    expect(canTransition('proposed', 'approved')).toBe(true);
    expect(canTransition('proposed', 'dispatched')).toBe(false);
    expect(() => assertTransition('proposed', 'dispatched')).toThrow(IllegalTransition);
  });

  it('walks approved → dispatched → in_progress → pr_open → merged → done', () => {
    const path = ['approved', 'dispatched', 'in_progress', 'pr_open', 'merged', 'done'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('lets a PR appear without the scan ever having seen the branch alone', () => {
    expect(canTransition('dispatched', 'pr_open')).toBe(true);
  });

  it('drops anything but a dropped item, and never revives one', () => {
    expect(canTransition('pr_open', 'dropped')).toBe(true);
    expect(canTransition('dropped', 'proposed')).toBe(false);
    expect(canTransition('done', 'pr_open')).toBe(false);
  });

  it('is idempotent, because the scan re-asserts what it already wrote', () => {
    expect(canTransition('pr_open', 'pr_open')).toBe(true);
  });

  it('rejects a status that is not a status at all', () => {
    expect(canTransition('proposed', 'shipped' as never)).toBe(false);
  });

  it('counts only in-flight statuses as "this repo already has work"', () => {
    expect(['approved', 'dispatched', 'in_progress', 'pr_open'].every((s) => isInFlight(s as never))).toBe(true);
    expect(['proposed', 'merged', 'done', 'dropped'].some((s) => isInFlight(s as never))).toBe(false);
  });

  it('reads GitHub without ever un-approving or re-opening work', () => {
    expect(statusFromGithub('dispatched', { branch: true })).toBe('in_progress');
    expect(statusFromGithub('in_progress', { branch: true, pr: true })).toBe('pr_open');
    expect(statusFromGithub('pr_open', { merged: true })).toBe('merged');
    // A proposal nobody approved is not "in progress" because a branch of the
    // same name happens to exist on the target repo.
    expect(statusFromGithub('proposed', { branch: true, pr: true })).toBe('proposed');
    expect(statusFromGithub('done', { merged: true })).toBe('done');
  });
});

describe('the dispatch vocabulary', () => {
  it('pins the branch, path and one-liner the write guard will allow', () => {
    expect(branchFor('add-stripe-checkout')).toBe('coachme/add-stripe-checkout');
    expect(oneLinerFor('add-stripe-checkout')).toBe(
      'Read prompts/coachme/add-stripe-checkout.md in this repo and execute it.'
    );
  });

  it('normalizes a title into a slug the CHECK constraint accepts', () => {
    expect(toSlug('Añadir pago con Bancard!')).toBe('anadir-pago-con-bancard');
    expect(isSlug(toSlug('Añadir pago con Bancard!'))).toBe(true);
    expect(isSlug('Not A Slug')).toBe(false);
    expect(isSlug('a'.repeat(41))).toBe(false);
  });
});
