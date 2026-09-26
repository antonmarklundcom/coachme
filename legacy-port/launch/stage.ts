/**
 * launch/stage.ts — what a repo's stage is allowed to become, and why.
 *
 * Pure: no database, no network. The scan (O4) feeds it evidence it has already
 * fetched; this file only judges. Three rules make it safe to run automatically
 * on 61 repos twice a week (plan.md §2, Decision D-C):
 *
 *   1. A raise needs EVIDENCE — a fetched URL, a green build, a rail that
 *      exists. Never a model's opinion, and never "it looks finished".
 *   2. At most ONE rung per run. If a repo deserves three, the next scan gives
 *      it the second; a single run that vaults a repo from `building` to
 *      `sellable` is far more likely to be a bug than a good week.
 *   3. NEVER lower. The drift guard from SCAN.md, applied to stages: a scan
 *      that cannot see the live URL today has learned that the fetch failed,
 *      not that the product died. Lowering is the owner's, by hand.
 *
 * `marketed` is unreachable from here on purpose: nothing an API can fetch
 * proves a human was told about a product. `earning` needs `first_revenue_at`,
 * which only the owner sets.
 */

import { STAGES, type Repo, type Stage, type StageEvidence, isoDate } from '../domain';

/** Evidence the caller has already gathered. Everything is optional: an absent
 *  signal means "not checked this run", never "false". */
export interface StageSignals {
  /** A CI run for the default branch came back green. */
  build_green?: boolean;
  /** The live URL was fetched this run and answered. */
  live_url_ok?: boolean;
  /** `sell_url` was fetched this run and answered. */
  sell_url_ok?: boolean;
  /** Overrides for values the caller is about to write to the row. */
  pct?: number;
  blocker?: string;
  payment_rail?: string | null;
  first_revenue_at?: string | null;
}

/** Blockers that do not contradict "this thing builds" (plan.md §2). */
const DEPLOYABLE_BLOCKERS = new Set(['none', 'db-setup', 'credentials']);

export interface StageClaim {
  stage: Stage;
  evidence: string;
}

/**
 * Every stage the evidence supports, lowest first. A repo that is live is also
 * deployable, so this is cumulative by construction rather than by assertion.
 */
export function claims(repo: Repo, signals: StageSignals = {}): StageClaim[] {
  const pct = signals.pct ?? repo.pct;
  const blocker = signals.blocker ?? repo.blocker;
  const rail = signals.payment_rail ?? repo.payment_rail;
  const firstRevenue = signals.first_revenue_at ?? repo.first_revenue_at;
  const out: StageClaim[] = [];

  if (signals.build_green) {
    out.push({ stage: 'deployable', evidence: 'CI is green on the default branch' });
  } else if (pct >= 90 && DEPLOYABLE_BLOCKERS.has(blocker)) {
    out.push({ stage: 'deployable', evidence: `scan reports ${pct}% with blocker "${blocker}"` });
  }

  const live = signals.live_url_ok ?? repo.live_url_ok;
  if (live === true) {
    out.push({ stage: 'live', evidence: `${repo.live_url ?? 'the live URL'} answers` });
  }

  if (signals.sell_url_ok === true) {
    out.push({ stage: 'sellable', evidence: `${repo.sell_url ?? 'the sell URL'} answers` });
  } else if (rail && rail !== 'none') {
    out.push({ stage: 'sellable', evidence: `payment rail "${rail}" is set` });
  }

  // `marketed` is never claimed automatically — see the header.

  if (firstRevenue) {
    out.push({ stage: 'earning', evidence: `first revenue recorded ${firstRevenue}` });
  }

  return out.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
}

/** The highest stage the evidence supports, ignoring the one-rung cap. */
export function supportedStage(repo: Repo, signals: StageSignals = {}): StageClaim | null {
  const all = claims(repo, signals);
  return all.length ? all[all.length - 1] : null;
}

/**
 * What a scan is allowed to write this run: one rung up, with its evidence, or
 * `null` for "leave it alone" — which is also the answer when the evidence
 * supports a LOWER stage than the row already carries.
 */
export function proposeStage(repo: Repo, signals: StageSignals = {}): StageClaim | null {
  const supported = supportedStage(repo, signals);
  if (!supported) return null;

  const current = STAGES.indexOf(repo.stage);
  const target = STAGES.indexOf(supported.stage);
  if (target <= current) return null;

  const next = STAGES[current + 1];
  // The evidence belongs to the stage it actually proves; when the cap holds a
  // repo back a rung, say so rather than attaching the wrong reason.
  return next === supported.stage
    ? supported
    : { stage: next, evidence: `${supported.evidence} (capped at one stage per run)` };
}

/** Append one evidence entry. Append-only: the history is the audit trail. */
export function withEvidence(
  repo: Pick<Repo, 'stage_evidence'>,
  claim: StageClaim,
  source: StageEvidence['source'],
  at: string = isoDate()
): StageEvidence[] {
  return [...(repo.stage_evidence ?? []), { ...claim, at, source }];
}

/**
 * The seed rule (plan.md §5 O3), also the answer for any repo that has never
 * been staged: a URL that answers is live, 90% is deployable, everything else
 * is still building.
 */
export function seedStage(repo: Pick<Repo, 'live_url_ok' | 'pct'>): Stage {
  if (repo.live_url_ok === true) return 'live';
  if (repo.pct >= 90) return 'deployable';
  return 'building';
}
