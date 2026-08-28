/**
 * momentum.ts — the momentum strip (DESIGN.md §2.6), ported from
 * scripts/legacy/src/scope.js onto Neon rows instead of portfolio.json.
 *
 * Pure: rows in, numbers out. lib/queries.ts supplies the repos/nudges.
 */

import { type Repo, isDormant, isOwnerBlocked, isoDate, ownerMinutes } from './domain';
import { dbBatches } from './score';
import { daysBetween } from './clock';
import type { NudgeRecord } from './nudge/history';

export interface MomentumStrip {
  launches: number;
  launch_names: string[];
  sessions: number;
  streak: number;
  remaining_minutes: number;
  baseline_minutes: number;
  remaining_h: string;
  baseline_h: string;
  burned_pct: number;
  owner_minutes_total: number;
}

/**
 * Days since the coach last asked for something and got nothing back. A quiet
 * day does not break it — DESIGN.md §3 calls silence a feature — only an
 * ignored ask does, because that is the one failure mode the owner controls.
 */
export function streakDays(nudges: NudgeRecord[], date: string): number {
  const history = nudges.filter((h) => h.local_date <= date);
  const lastIgnored = [...history]
    .filter((h) => h.outcome === 'ignored')
    .sort((a, b) => b.local_date.localeCompare(a.local_date))[0];
  if (!lastIgnored) {
    const first = [...history].sort((a, b) => a.local_date.localeCompare(b.local_date))[0];
    return first ? Math.max(0, daysBetween(date, first.local_date)) : 0;
  }
  return Math.max(0, daysBetween(date, lastIgnored.local_date));
}

export interface MomentumOptions {
  date?: string;
  /** settings.hpanel_baseline_minutes; 0/null both mean "not set yet". */
  baselineMinutes?: number | null;
}

export function momentum(repos: Repo[], nudges: NudgeRecord[], opts: MomentumOptions = {}): MomentumStrip {
  const date = opts.date ?? isoDate();
  const remaining = dbBatches(repos, { date }).reduce((sum, b) => sum + b.minutes, 0);
  const baseline = opts.baselineMinutes || remaining;

  const launches = repos.filter(
    (r) => !!r.launched_at && daysBetween(date, r.launched_at) >= 0 && daysBetween(date, r.launched_at) <= 31
  );
  const sessions = nudges.filter((h) => h.type === 'db-session' && h.outcome === 'acted').length;

  return {
    launches: launches.length,
    launch_names: launches.map((r) => r.name),
    sessions,
    streak: streakDays(nudges, date),
    remaining_minutes: remaining,
    baseline_minutes: baseline,
    remaining_h: (remaining / 60).toFixed(1),
    baseline_h: (baseline / 60).toFixed(1),
    burned_pct: baseline > 0 ? Math.max(0, Math.min(100, Math.round(((baseline - remaining) / baseline) * 100))) : 0,
    owner_minutes_total: repos
      .filter((r) => isOwnerBlocked(r) && !isDormant(r, date))
      .reduce((sum, r) => sum + ownerMinutes(r), 0),
  };
}
