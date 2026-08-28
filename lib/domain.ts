/**
 * domain.ts — the vocabulary of the portfolio, ported from
 * scripts/legacy/src/portfolio.js and scripts/legacy/src/scope.js.
 *
 * Pure: no database, no network. Everything here is a definition the coaching
 * logic in DESIGN.md rests on, so it is kept in one place and unit-tested.
 */

export const LANES = [
  'launch-owner-blocked',
  'launch-agent-drivable',
  'mid-agent-drivable',
  'mid-owner-stalled',
  'early-open',
  'early-owner-stalled',
] as const;
export type Lane = (typeof LANES)[number];

export const BLOCKERS = [
  'db-setup',
  'credentials',
  'integration',
  'facts',
  'confirmation',
  'sibling',
  'none',
  'scope-undefined',
  'deferred',
  'owner-setup-unclassified',
] as const;
export type Blocker = (typeof BLOCKERS)[number];

export const TIERS = ['infra', 'revenue', 'experiment'] as const;
export type Tier = (typeof TIERS)[number];

/** Blockers whose owner is the owner, not an agent. */
export const OWNER_BLOCKERS: Blocker[] = [
  'db-setup',
  'credentials',
  'integration',
  'facts',
  'confirmation',
  'scope-undefined',
  'owner-setup-unclassified',
];

/**
 * Estimated owner-minutes per blocker category. Feeds the effort penalty in
 * score.ts and the "45 min unblocks 3 launches" headline. Coarse on purpose —
 * planning numbers, not measurements.
 */
export const BLOCKER_MINUTES: Record<Blocker, number> = {
  'db-setup': 20,
  credentials: 10,
  integration: 30,
  facts: 5,
  confirmation: 3,
  sibling: 0,
  none: 0,
  'scope-undefined': 15,
  deferred: 0,
  // Priced pessimistically on purpose: an unclassified blocker should lose to a
  // known 20-minute DB task until it is classified (Decision D6).
  'owner-setup-unclassified': 25,
};

export type ClearedBlocker = { blocker: Blocker; date?: string };

/** One row of `repos`, as the service layer hands it to callers. */
export interface Repo {
  id: number;
  name: string;
  github_full_name: string | null;
  pct: number;
  lane: Lane;
  blocker: Blocker;
  tier: Tier;
  hostinger_account: string | null;
  market: 'se' | 'py' | null;
  next_step: string | null;
  open_prs: number;
  merged_prs_30d: number;
  live_url: string | null;
  live_url_ok: boolean | null;
  launched_at: string | null;
  unblocks: string[];
  depends_on: string[];
  related: string[];
  unblocks_revenue: boolean | null;
  notes: string | null;
  cleared_blockers: ClearedBlocker[];
  snoozed_until: string | null;
  scope_review_due: boolean;
  scope_review_proposed: string | null;
  scope_reviews_unanswered: number;
  kept_at: string | null;
  killed_at: string | null;
  last_commit_at: string | null;
  pushed_at: string | null;
  last_scan_at: string | null;
  last_scan_head_sha: string | null;
  blocked_scans: number;
  newly_blocked_at: string | null;
}

export function isoDate(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Dates in this app are either `YYYY-MM-DD` or full ISO timestamps. */
export function asTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value.length === 10 ? `${value}T12:00:00Z` : value);
}

export function isOwnerBlocked(repo: Pick<Repo, 'blocker'>): boolean {
  return OWNER_BLOCKERS.includes(repo.blocker);
}

export function ownerMinutes(repo: Pick<Repo, 'blocker'>): number {
  return BLOCKER_MINUTES[repo.blocker] ?? 0;
}

export function isKilled(repo: Pick<Repo, 'killed_at'>): boolean {
  return !!repo.killed_at;
}

export function isSnoozed(repo: Pick<Repo, 'snoozed_until'>, date: string): boolean {
  return !!repo.snoozed_until && asTime(repo.snoozed_until) > asTime(date);
}

/** Killed or sleeping: the owner has said, in as many words, "don't show me this". */
export function isDormant(repo: Pick<Repo, 'killed_at' | 'snoozed_until'>, date: string = isoDate()): boolean {
  return isKilled(repo) || isSnoozed(repo, date);
}

/** True once the owner has ticked any blocker clear on this repo (drift-guard provenance). */
export function hasOwnerClearedBlocker(repo: Pick<Repo, 'cleared_blockers'>): boolean {
  return Array.isArray(repo.cleared_blockers) && repo.cleared_blockers.length > 0;
}

/**
 * The lane a repo belongs in once its blocker is gone: launch-stage repos become
 * agent-drivable, mid/early repos just lose the stall.
 */
export function unblockedLane(lane: Lane): Lane {
  switch (lane) {
    case 'launch-owner-blocked':
      return 'launch-agent-drivable';
    case 'mid-owner-stalled':
      return 'mid-agent-drivable';
    case 'early-owner-stalled':
      return 'early-open';
    default:
      return lane;
  }
}

/** Reverse dependency edges: who does launching `name` unblock? */
export function unblockedBy(repos: Repo[], name: string): string[] {
  const self = repos.find((r) => r.name === name);
  const direct = self?.unblocks ?? [];
  const reverse = repos.filter((r) => (r.depends_on ?? []).includes(name)).map((r) => r.name);
  return [...new Set([...direct, ...reverse])];
}
