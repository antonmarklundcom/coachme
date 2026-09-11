/**
 * report/weekly.ts — Monday's money report (Decision D-J).
 *
 * Written by the Monday `/api/nudge` run into `settings.weekly_report`, rendered
 * by the money desk (S5) and the home page (S6). It is the one place the app
 * answers the question v2 could not: **did anything get closer to money this
 * week, and what is the nearest thing to it now?**
 *
 * Deliberately a snapshot rather than a time series: one row, overwritten every
 * Monday. A portfolio of 61 repos generates enough history in `nudges`,
 * `scan_events` and `stage_evidence` to reconstruct any week that matters; a
 * second, summarised copy of it would only be another thing to keep in sync.
 *
 * `buildWeeklyReport` is pure so the arithmetic is testable without a database.
 */

import { addDays } from '../clock';
import { type Repo, type StageEvidence, type WorkItem } from '../domain';
import { moneyQueue } from '../score';
import { getRepos, getWorkItems, setWeeklyReport } from '../queries';

export interface WeeklyReport {
  week_of: string;
  generated_at: string;
  /** The five repos nearest their first invoice, nearest first. */
  closest: { repo: string; stage: string; distance: number; blocker: string; next_step: string | null }[];
  /** Stages raised in the last seven days, with the evidence that did it. */
  stage_changes: { repo: string; stage: string; evidence: string; at: string; source: string }[];
  /** Work that landed: items merged or finished in the last seven days. */
  shipped: { repo: string; slug: string; title: string }[];
  /** The single owner step on the closest-to-money repo, if there is one. */
  owner_step: { repo: string; slug: string; title: string; minutes: number | null } | null;
  totals: { repos: number; live_or_better: number; earning: number; open_items: number; green_prs: number };
}

const AHEAD_OF_LIVE = new Set(['live', 'sellable', 'marketed', 'earning']);

export interface WeeklyInput {
  date: string;
  repos: Repo[];
  items: WorkItem[];
}

export function buildWeeklyReport({ date, repos, items }: WeeklyInput): WeeklyReport {
  const since = addDays(date, -7);
  const nameOf = new Map(repos.map((r) => [r.id, r.name]));
  const ranked = moneyQueue(repos, { date });

  const stage_changes = repos
    .flatMap((repo) =>
      (repo.stage_evidence ?? [])
        .filter((e: StageEvidence) => e.source !== 'seed' && (e.at ?? '').slice(0, 10) >= since)
        .map((e: StageEvidence) => ({
          repo: repo.name,
          stage: e.stage,
          evidence: e.evidence,
          at: (e.at ?? '').slice(0, 10),
          source: e.source,
        }))
    )
    .sort((a, b) => b.at.localeCompare(a.at));

  const shipped = items
    .filter((i) => (i.status === 'merged' || i.status === 'done') && i.updated_at.slice(0, 10) >= since)
    .map((i) => ({ repo: nameOf.get(i.repo_id) ?? String(i.repo_id), slug: i.slug, title: i.title }));

  // The owner step that matters is the one on the nearest repo — not the oldest,
  // not the shortest. Anton has one scarce hour; it belongs to whatever is
  // closest to a first invoice.
  let owner_step: WeeklyReport['owner_step'] = null;
  for (const entry of ranked) {
    const step = items.find(
      (i) =>
        i.repo_id === entry.repo.id &&
        i.kind === 'owner' &&
        ['proposed', 'approved', 'dispatched'].includes(i.status)
    );
    if (step) {
      owner_step = {
        repo: entry.repo.name,
        slug: step.slug,
        title: step.title,
        minutes: step.estimate_minutes,
      };
      break;
    }
  }

  return {
    week_of: date,
    generated_at: new Date().toISOString(),
    closest: ranked.slice(0, 5).map((e) => ({
      repo: e.repo.name,
      stage: e.repo.stage,
      distance: e.distance,
      blocker: e.repo.blocker,
      next_step: e.repo.next_step,
    })),
    stage_changes,
    shipped,
    owner_step,
    totals: {
      repos: repos.length,
      live_or_better: repos.filter((r) => AHEAD_OF_LIVE.has(r.stage)).length,
      earning: repos.filter((r) => r.stage === 'earning').length,
      open_items: items.filter((i) => !['done', 'dropped', 'merged'].includes(i.status)).length,
      green_prs: items.filter((i) => i.status === 'pr_open' && i.pr_state === 'green').length,
    },
  };
}

/** Build it from the database and store it. Monday's `/api/nudge` calls this. */
export async function writeWeeklyReport(date: string): Promise<WeeklyReport> {
  const [repos, items] = await Promise.all([getRepos(), getWorkItems()]);
  const report = buildWeeklyReport({ date, repos, items });
  await setWeeklyReport(report as unknown as Record<string, unknown>);
  return report;
}
