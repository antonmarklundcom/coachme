/**
 * scan/plan.ts — which repos are worth deep-reading.
 *
 * Ported from scripts/legacy/src/refresh.js `planScan`, keeping SCAN.md's
 * "Why it is incremental" table exactly: 53 repos re-read twice a week is slow,
 * expensive and almost entirely wasted, so one cheap listing decides, and only
 * what actually moved is read.
 */

import { type Repo, asTime } from '../domain';

const DAY = 24 * 60 * 60 * 1000;

/** The cheap listing: repo name → `pushed_at` (GitHub API) or `head` (git ls-remote). */
export interface RemoteInfo {
  pushed_at?: string;
  head?: string;
  archived?: boolean;
}
export type RemoteListing = Record<string, RemoteInfo>;

export interface PlanOptions {
  now?: number;
  force?: string[];
  maxAgeDays?: number;
  /** The 2026-08 audit counts as every repo's last scan until a real one lands. */
  baselineScan?: string | null;
}

export interface PlanResult {
  deep: { name: string; why: string }[];
  skipped: { name: string; why: string }[];
  unknown: string[];
}

export function planScan(repos: Repo[], remote: RemoteListing = {}, opts: PlanOptions = {}): PlanResult {
  const { now = Date.now(), force = [], maxAgeDays = 30, baselineScan = null } = opts;
  const deep: PlanResult['deep'] = [];
  const skipped: PlanResult['skipped'] = [];
  const unknown: string[] = [];

  for (const repo of repos) {
    const info = remote[repo.name];
    if (!info) {
      unknown.push(repo.name);
      continue;
    }
    if (info.archived) {
      skipped.push({ name: repo.name, why: 'archived on GitHub' });
      continue;
    }
    if (force.includes(repo.name)) {
      deep.push({ name: repo.name, why: 'forced' });
      continue;
    }
    // The audit could not say what these repos actually need (Decision D6), and
    // several sit at 85–95%. Waiting for a push that may never come would leave
    // the queue ranking them on percentage alone; read them once, then
    // `last_scan_at` stops the forcing so an unclassifiable repo is asked
    // about rather than re-read forever.
    if (repo.blocker === 'owner-setup-unclassified' && !repo.last_scan_at) {
      deep.push({ name: repo.name, why: 'blocker never classified' });
      continue;
    }
    const since = repo.last_scan_at ?? baselineScan;
    if (!since) {
      deep.push({ name: repo.name, why: 'never scanned' });
      continue;
    }
    if (info.pushed_at && asTime(info.pushed_at) > asTime(since)) {
      deep.push({ name: repo.name, why: `pushed ${info.pushed_at.slice(0, 10)}` });
      continue;
    }
    // `git ls-remote` fallback: a changed head SHA means the same thing as a
    // newer pushed_at and costs no API call.
    if (info.head && repo.last_scan_head_sha && info.head !== repo.last_scan_head_sha) {
      deep.push({ name: repo.name, why: `head moved to ${info.head.slice(0, 7)}` });
      continue;
    }
    if (info.head && !repo.last_scan_head_sha) {
      deep.push({ name: repo.name, why: 'no head recorded yet' });
      continue;
    }
    if ((now - asTime(since)) / DAY >= maxAgeDays) {
      deep.push({ name: repo.name, why: `record is ${Math.round((now - asTime(since)) / DAY)} days old` });
      continue;
    }
    skipped.push({ name: repo.name, why: repo.last_scan_at ? 'no new commits' : 'unchanged since the audit' });
  }

  return { deep, skipped, unknown };
}
