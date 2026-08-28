/**
 * The drift guard, and what decides a deep scan.
 *
 * These tests are the contract phase O1 owes the later phases: SCAN.md's
 * "What the scan may and may not change" table, one case per row. Sonnet
 * phases may not redesign this (plan.md §4.7), so it is pinned here.
 */

import { describe, expect, it } from 'vitest';
import type { Repo } from '../lib/domain';
import { BLOCKED_SCANS_LIMIT, autoProposeSnooze, decideScanUpdate, stalenessSweep } from '../lib/scan/apply';
import { planScan } from '../lib/scan/plan';
import { sanitizeFinding } from '../lib/scan/classify';

const DATE = '2026-09-01';
const NOW = Date.parse('2026-09-01T12:00:00Z');

function repo(partial: Partial<Repo> & { name: string }): Repo {
  return {
    id: 1,
    github_full_name: `antonmarklundcom/${partial.name}`,
    pct: 50,
    lane: 'launch-owner-blocked',
    blocker: 'db-setup',
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

describe('drift guard', () => {
  it('applies a percentage that went up', () => {
    const d = decideScanUpdate(repo({ name: 'besikt', pct: 90 }), { pct: 95 }, { date: DATE, now: NOW });
    expect(d.patch.pct).toBe(95);
    expect(d.verifyReason).toBeNull();
  });

  it('never applies a percentage that went down — it asks instead', () => {
    const d = decideScanUpdate(repo({ name: 'besikt', pct: 90 }), { pct: 60 }, { date: DATE, now: NOW });
    expect(d.patch.pct).toBeUndefined();
    expect(d.verifyReason).toMatch(/60% done, the record says 90%/);
  });

  it('applies a new blocker on a repo the owner never ticked clear, and flags it', () => {
    const before = repo({ name: 'idioma', blocker: 'none', lane: 'launch-agent-drivable' });
    const d = decideScanUpdate(before, { blocker: 'credentials' }, { date: DATE, now: NOW });
    expect(d.patch.blocker).toBe('credentials');
    expect(d.patch.newly_blocked_at).toBe(DATE);
    expect(d.changes.join(' ')).toMatch(/newly blocked on you/);
  });

  it('never re-blocks a repo the owner ticked clear — it asks instead', () => {
    const before = repo({
      name: 'besikt',
      blocker: 'none',
      lane: 'launch-agent-drivable',
      cleared_blockers: [{ blocker: 'db-setup', date: '2026-08-25' }],
    });
    const d = decideScanUpdate(before, { blocker: 'db-setup' }, { date: DATE, now: NOW });
    expect(d.patch.blocker).toBeUndefined();
    expect(d.verifyReason).toMatch(/Did it actually go through\?/);
  });

  it('marks a repo launched when its live URL answers', () => {
    const d = decideScanUpdate(repo({ name: 'qr', pct: 95 }), { live_url_ok: true }, { date: DATE, now: NOW });
    expect(d.launched).toBe(true);
    expect(d.patch).toMatchObject({ pct: 100, blocker: 'none', lane: 'launch-agent-drivable', launched_at: DATE });
  });

  it('does not re-launch a repo that is already launched', () => {
    const d = decideScanUpdate(
      repo({ name: 'qr', pct: 100, blocker: 'none', launched_at: '2026-08-01' }),
      { live_url_ok: true },
      { date: DATE, now: NOW }
    );
    expect(d.launched).toBe(false);
    expect(d.patch.launched_at).toBeUndefined();
  });

  it('counts consecutive owner-blocked scans and calls out the third', () => {
    const d = decideScanUpdate(
      repo({ name: 'besikt', blocked_scans: BLOCKED_SCANS_LIMIT - 1 }),
      {},
      { date: DATE, now: NOW }
    );
    expect(d.patch.blocked_scans).toBe(BLOCKED_SCANS_LIMIT);
    expect(d.changes.join(' ')).toMatch(/owner-blocked for 3 scans running/);
  });

  it('resets the counter once the blocker is no longer the owner’s', () => {
    const d = decideScanUpdate(
      repo({ name: 'besikt', blocked_scans: 2 }),
      { blocker: 'none' },
      { date: DATE, now: NOW }
    );
    expect(d.patch.blocked_scans).toBe(0);
    expect(d.patch.newly_blocked_at).toBeNull();
  });

  it('always refreshes bookkeeping, even when it withholds the finding', () => {
    const d = decideScanUpdate(
      repo({ name: 'besikt', pct: 90 }),
      { pct: 10, head: 'abc1234', last_commit: '2026-08-30', open_prs: 2 },
      { date: DATE, now: NOW }
    );
    expect(d.verifyReason).not.toBeNull();
    expect(d.patch).toMatchObject({ last_scan_head_sha: 'abc1234', last_commit_at: '2026-08-30', open_prs: 2 });
  });
});

describe('what gets deep-scanned', () => {
  const baseline = '2026-08-01';

  it('reads a repo pushed since its last scan, and skips one that did not move', () => {
    const repos = [
      repo({ name: 'moved', last_scan_at: '2026-08-20T00:00:00Z' }),
      repo({ name: 'still', last_scan_at: '2026-08-20T00:00:00Z' }),
    ];
    const plan = planScan(
      repos,
      { moved: { pushed_at: '2026-08-27T10:00:00Z' }, still: { pushed_at: '2026-08-02T10:00:00Z' } },
      { now: NOW, baselineScan: baseline }
    );
    expect(plan.deep.map((d) => d.name)).toEqual(['moved']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['still']);
  });

  it('reads an unclassified blocker once, without waiting for a push', () => {
    const repos = [repo({ name: 'gruas', blocker: 'owner-setup-unclassified' })];
    const first = planScan(repos, { gruas: { pushed_at: '2026-07-01T00:00:00Z' } }, { now: NOW, baselineScan: baseline });
    expect(first.deep[0].why).toMatch(/never classified/);

    // Once scanned it queues normally rather than being re-read forever.
    const scanned = [repo({ name: 'gruas', blocker: 'owner-setup-unclassified', last_scan_at: '2026-08-30T00:00:00Z' })];
    const second = planScan(scanned, { gruas: { pushed_at: '2026-07-01T00:00:00Z' } }, { now: NOW, baselineScan: baseline });
    expect(second.deep).toHaveLength(0);
  });

  it('treats a moved head SHA like a newer push', () => {
    const repos = [repo({ name: 'x', last_scan_at: '2026-08-30T00:00:00Z', last_scan_head_sha: 'aaaa' })];
    const plan = planScan(repos, { x: { head: 'bbbb' } }, { now: NOW, baselineScan: baseline });
    expect(plan.deep[0].why).toMatch(/head moved/);
  });

  it('re-reads a record that has gone stale, and skips archived repos', () => {
    const repos = [
      repo({ name: 'old', last_scan_at: '2026-06-01T00:00:00Z' }),
      repo({ name: 'dead', last_scan_at: '2026-06-01T00:00:00Z' }),
    ];
    const plan = planScan(
      repos,
      { old: { pushed_at: '2026-06-01T00:00:00Z' }, dead: { archived: true } },
      { now: NOW, baselineScan: baseline }
    );
    expect(plan.deep.map((d) => d.name)).toEqual(['old']);
    expect(plan.skipped[0]).toMatchObject({ name: 'dead', why: 'archived on GitHub' });
  });

  it('reports repos GitHub never listed rather than guessing about them', () => {
    const plan = planScan([repo({ name: 'ghost' })], {}, { now: NOW, baselineScan: baseline });
    expect(plan.unknown).toEqual(['ghost']);
    expect(plan.deep).toHaveLength(0);
  });
});

describe('sweeps', () => {
  it('flags untouched early-stage repos, and exempts nearly finished ones', () => {
    const repos = [
      repo({ name: 'stale', pct: 30, last_commit_at: '2026-06-01' }),
      repo({ name: 'nearly', pct: 95, last_commit_at: '2026-06-01' }),
      repo({ name: 'fresh', pct: 30, last_commit_at: '2026-08-30' }),
    ];
    expect(stalenessSweep(repos, { now: NOW, date: DATE, scopeReviewLast: null })).toEqual(['stale']);
  });

  it('stays quiet when the monthly review is not due yet', () => {
    const repos = [repo({ name: 'stale', pct: 30, last_commit_at: '2026-06-01' })];
    expect(stalenessSweep(repos, { now: NOW, date: DATE, scopeReviewLast: '2026-08-25' })).toEqual([]);
  });

  it('proposes — never applies — a snooze after two ignored reviews', () => {
    const once = autoProposeSnooze([repo({ name: 'a', scope_review_due: true, scope_reviews_unanswered: 0 })]);
    expect(once[0]).toMatchObject({ unanswered: 1, propose: false });

    const twice = autoProposeSnooze([repo({ name: 'a', scope_review_due: true, scope_reviews_unanswered: 1 })]);
    expect(twice[0]).toMatchObject({ unanswered: 2, propose: true });
  });
});

describe('finding sanitizer', () => {
  it('keeps only fields the scan is allowed to report', () => {
    const finding = sanitizeFinding({
      pct: '87',
      blocker: 'db-setup',
      lane: 'launch-owner-blocked',
      next_step: '  create the DB  ',
      open_prs: 2,
      live_url_ok: true, // judgement is not evidence — must be dropped
      killed: true,
      pushed_at: '2026-09-01',
    });
    expect(finding).toEqual({
      pct: 87,
      blocker: 'db-setup',
      lane: 'launch-owner-blocked',
      next_step: 'create the DB',
      open_prs: 2,
    });
  });

  it('drops values outside the vocabulary rather than inventing them', () => {
    expect(sanitizeFinding({ pct: 140, blocker: 'vibes', lane: 'nowhere' })).toEqual({});
    expect(sanitizeFinding('not an object')).toEqual({});
  });
});
