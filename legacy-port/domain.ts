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

/**
 * The road from a green build to a paid invoice (plan.md §2, Decision D-C).
 * Ordered: index is the rung, and the whole money ranking is derived from it,
 * so the order of this array is load-bearing — not an alphabetical list.
 *
 *   building    it does not deploy yet
 *   deployable  it builds and could be deployed, but is not
 *   live        a URL answers
 *   sellable    someone could pay: a price is stated and a rail exists
 *   marketed    someone has been told about it
 *   earning     someone has paid
 */
export const STAGES = [
  'building',
  'deployable',
  'live',
  'sellable',
  'marketed',
  'earning',
] as const;
export type Stage = (typeof STAGES)[number];

export const REVENUE_MODELS = [
  'saas',
  'lead-gen',
  'ecommerce',
  'content-ads',
  'service',
  'internal',
  'unknown',
] as const;
export type RevenueModel = (typeof REVENUE_MODELS)[number];

export const CURRENCIES = ['PYG', 'SEK', 'USD', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PAYMENT_RAILS = [
  'stripe',
  'swish',
  'bancard',
  'transfer',
  'whatsapp-manual',
  'none',
] as const;
export type PaymentRail = (typeof PAYMENT_RAILS)[number];

/** One recorded reason a repo's stage is what it is. Append-only. */
export interface StageEvidence {
  stage: Stage;
  evidence: string;
  at: string;
  source: 'scan' | 'owner' | 'seed';
}

/** How many rungs are left between `stage` and `earning`. 0 means earning. */
export function stageGap(stage: Stage | string): number {
  const index = STAGES.indexOf(stage as Stage);
  if (index < 0) return STAGES.length - 1; // unknown value: treat as furthest away
  return STAGES.length - 1 - index;
}

/** Stage comparison in road order: negative when `a` is behind `b`. */
export function compareStages(a: Stage | string, b: Stage | string): number {
  return stageGap(b) - stageGap(a);
}

/**
 * The work the desk hands out (Decision D-D). `prompt_md` is the whole prompt
 * body, stored on the row rather than regenerated: what the owner approved and
 * what the agent reads must be the same bytes.
 */
export const WORK_STATUSES = [
  'proposed',
  'approved',
  'dispatched',
  'in_progress',
  'pr_open',
  'merged',
  'done',
  'dropped',
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_KINDS = ['agent', 'owner'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_TOOLS = ['claude', 'codex', 'either', 'owner'] as const;
export type WorkTool = (typeof WORK_TOOLS)[number];

/** Opus or Sonnet. Never Fable, anywhere in this codebase (plan.md §4.8). */
export const WORK_MODELS = ['opus', 'sonnet'] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

export const DISPATCH_TARGETS = ['repo-file', 'issue', 'copy'] as const;
export type DispatchTarget = (typeof DISPATCH_TARGETS)[number];

export const PR_STATES = ['open', 'green', 'red', 'conflict', 'merged'] as const;
export type PrState = (typeof PR_STATES)[number];

export interface WorkItem {
  id: number;
  repo_id: number;
  slug: string;
  title: string;
  kind: WorkKind;
  tool: WorkTool;
  model: WorkModel | null;
  stage_target: Stage;
  prompt_md: string;
  one_liner: string;
  estimate_minutes: number | null;
  status: WorkStatus;
  source: 'generator' | 'owner' | 'scan';
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: PrState | null;
  note: string | null;
  dispatched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Dispatch {
  id: number;
  work_item_id: number;
  target: DispatchTarget;
  commit_sha: string | null;
  issue_url: string | null;
  created_at: string;
}

export interface RevenueCheck {
  id: number;
  repo_id: number;
  key: string;
  label: string;
  done_at: string | null;
  source: 'playbook' | 'owner';
}

/** The branch every dispatched agent works on, and the PR-title marker (D-E). */
export function branchFor(slug: string): string {
  return `coachme/${slug}`;
}

export function promptPathFor(slug: string): string {
  return `prompts/coachme/${slug}.md`;
}

export function oneLinerFor(slug: string): string {
  return `Read ${promptPathFor(slug)} in this repo and execute it.`;
}

/** kebab-case, <= 40 chars — the shape the migration's CHECK constraint pins. */
export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

/** Best-effort slug from a title; the generator proposes, this normalizes. */
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

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
  // The launch desk (plan.md §2). `stage` is never null: 0003 defaults it.
  stage: Stage;
  revenue_model: RevenueModel | null;
  price_note: string | null;
  currency: Currency | null;
  payment_rail: PaymentRail | null;
  channel: string | null;
  sell_url: string | null;
  first_revenue_at: string | null;
  revenue_30d: number | null;
  stage_evidence: StageEvidence[];
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
