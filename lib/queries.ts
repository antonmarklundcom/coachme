/**
 * queries.ts — the service layer. Pages, routes and scripts read and write the
 * portfolio through these functions; nothing else issues SQL.
 *
 * Later (Sonnet) phases may add *display* queries here, but not new business
 * logic and never raw SQL in a component (plan.md §4.7).
 */

import { query, one } from './db';
import {
  type Blocker,
  type Lane,
  type Repo,
  isoDate,
  unblockedLane,
} from './domain';
import { dbBatches, launchQueue, agentLane, rank, type DbBatch, type ScoredRepo } from './score';

const REPO_COLUMNS = `
  id, name, github_full_name, pct, lane, blocker, tier, hostinger_account, market,
  next_step, open_prs, merged_prs_30d, live_url, live_url_ok,
  to_char(launched_at, 'YYYY-MM-DD') AS launched_at,
  unblocks, depends_on, related, unblocks_revenue, notes, cleared_blockers,
  to_char(snoozed_until, 'YYYY-MM-DD') AS snoozed_until,
  scope_review_due, scope_review_proposed, scope_reviews_unanswered,
  to_char(kept_at, 'YYYY-MM-DD') AS kept_at,
  to_char(killed_at, 'YYYY-MM-DD') AS killed_at,
  to_char(last_commit_at, 'YYYY-MM-DD') AS last_commit_at,
  pushed_at, last_scan_at, last_scan_head_sha, blocked_scans,
  to_char(newly_blocked_at, 'YYYY-MM-DD') AS newly_blocked_at
`;

function normalize(row: Record<string, unknown>): Repo {
  return {
    ...row,
    unblocks: (row.unblocks as string[]) ?? [],
    depends_on: (row.depends_on as string[]) ?? [],
    related: (row.related as string[]) ?? [],
    cleared_blockers: (row.cleared_blockers as Repo['cleared_blockers']) ?? [],
    pushed_at: row.pushed_at ? new Date(row.pushed_at as string).toISOString() : null,
    last_scan_at: row.last_scan_at ? new Date(row.last_scan_at as string).toISOString() : null,
  } as Repo;
}

export async function getRepos(): Promise<Repo[]> {
  const rows = await query(`SELECT ${REPO_COLUMNS} FROM repos ORDER BY name`);
  return rows.map(normalize);
}

export async function getRepo(name: string): Promise<Repo | null> {
  const row = await one(`SELECT ${REPO_COLUMNS} FROM repos WHERE name = $1`, [name]);
  return row ? normalize(row) : null;
}

/**
 * Partial update of one repo row, always stamping `updated_at`.
 *
 * Column names are interpolated (Postgres cannot parameterise an identifier),
 * so they are checked against the identifier shape first — values always go
 * through placeholders.
 */
export async function updateRepo(id: number, patch: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`refusing to update suspicious column "${key}"`);
  }
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => {
    const v = patch[k];
    return Array.isArray(v) || (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
  });
  await query(`UPDATE repos SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [id, ...values]);
}

/**
 * The transition a ticked "besikt DB done" box performs: record the clear (with
 * its date) so the drift guard can tell a human tick from a stale audit, then
 * move the repo out of its owner-stalled lane.
 */
export async function clearBlocker(
  repo: Repo,
  blocker: Blocker,
  { date = isoDate() }: { date?: string } = {}
): Promise<void> {
  if (repo.blocker !== blocker) {
    throw new Error(`repo "${repo.name}" is blocked on "${repo.blocker}", not "${blocker}"`);
  }
  await updateRepo(repo.id, {
    cleared_blockers: [...repo.cleared_blockers, { blocker, date }],
    blocker: 'none' as Blocker,
    lane: unblockedLane(repo.lane) as Lane,
  });
}

/* ------------------------------------------------------------------ settings */

export interface Settings {
  owner_timezone: string;
  hpanel_baseline_minutes: number;
  scope_review_last: string | null;
  session_state: Record<string, unknown>;
}

export async function getSettings(): Promise<Settings> {
  const row = await one<{
    owner_timezone: string;
    hpanel_baseline_minutes: number;
    scope_review_last: string | null;
    session_state: Record<string, unknown>;
  }>(
    `SELECT owner_timezone, hpanel_baseline_minutes,
            to_char(scope_review_last, 'YYYY-MM-DD') AS scope_review_last, session_state
     FROM settings WHERE id = TRUE`
  );
  return (
    row ?? {
      owner_timezone: 'America/Asuncion',
      hpanel_baseline_minutes: 0,
      scope_review_last: null,
      session_state: {},
    }
  );
}

/* ----------------------------------------------------------------- decisions */

export interface Decision {
  id: string;
  question: string;
  needed_for: string | null;
  recommended: string | null;
  why: string | null;
  status: 'pending' | 'accepted' | 'corrected';
  answer: string | null;
  batch: string | null;
}

export async function getDecisions(status?: Decision['status']): Promise<Decision[]> {
  const rows = status
    ? await query(`SELECT * FROM decisions WHERE status = $1 ORDER BY id`, [status])
    : await query(`SELECT * FROM decisions ORDER BY id`);
  return rows as unknown as Decision[];
}

/* -------------------------------------------------------------------- stacks */

export interface Stack {
  repo_id: number;
  package_name: string | null;
  engine: string | null;
  dialect: string | null;
  package_manager: string | null;
  migrations: number;
  scripts: Record<string, string | null>;
  env_file: string | null;
  env_session: string[];
  env_deferred_count: number;
  notes: string[];
  scanned_at: string;
}

export async function getStack(repoId: number): Promise<Stack | null> {
  return (await one(`SELECT * FROM stacks WHERE repo_id = $1`, [repoId])) as unknown as Stack | null;
}

/**
 * Upsert stack metadata. Never credentials — only the NAMES of env vars
 * (plan.md §2; the hard rule from PLAN.md's runbook generator carries over).
 */
export async function upsertStack(repoId: number, stack: Partial<Stack>): Promise<void> {
  await query(
    `INSERT INTO stacks (repo_id, package_name, engine, dialect, package_manager, migrations, scripts,
                         env_file, env_session, env_deferred_count, notes, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (repo_id) DO UPDATE SET
       package_name = EXCLUDED.package_name,
       engine = EXCLUDED.engine, dialect = EXCLUDED.dialect,
       package_manager = EXCLUDED.package_manager, migrations = EXCLUDED.migrations,
       scripts = EXCLUDED.scripts, env_file = EXCLUDED.env_file,
       env_session = EXCLUDED.env_session, env_deferred_count = EXCLUDED.env_deferred_count,
       notes = EXCLUDED.notes, scanned_at = now()`,
    [
      repoId,
      stack.package_name ?? null,
      stack.engine ?? null,
      stack.dialect ?? null,
      stack.package_manager ?? null,
      stack.migrations ?? 0,
      JSON.stringify(stack.scripts ?? {}),
      stack.env_file ?? null,
      JSON.stringify(stack.env_session ?? []),
      stack.env_deferred_count ?? 0,
      JSON.stringify(stack.notes ?? []),
    ]
  );
}

/* --------------------------------------------------------------- scan events */

export interface ScanEventInput {
  repo_id: number | null;
  source: 'cron' | 'manual';
  findings: Record<string, unknown>;
  applied: boolean;
  verify_reason?: string | null;
}

/**
 * The audit trail. `repos` is never written from a scan without one of these
 * first (SCAN.md: "a scan is an estimate, a tick is a fact").
 */
export async function recordScanEvent(event: ScanEventInput): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO scan_events (repo_id, source, findings, applied, verify_reason)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [event.repo_id, event.source, JSON.stringify(event.findings), event.applied, event.verify_reason ?? null]
  );
  return row!.id;
}

export interface VerifyItem {
  id: number;
  repo_name: string | null;
  verify_reason: string;
  findings: Record<string, unknown>;
  created_at: string;
}

/** Open drift-guard questions — what the dashboard asks the owner to settle. */
export async function getOpenVerifyItems(): Promise<VerifyItem[]> {
  const rows = await query(
    `SELECT e.id, r.name AS repo_name, e.verify_reason, e.findings, e.created_at
     FROM scan_events e LEFT JOIN repos r ON r.id = e.repo_id
     WHERE e.verify_reason IS NOT NULL AND e.resolved_at IS NULL
     ORDER BY e.created_at DESC`
  );
  return rows as unknown as VerifyItem[];
}

export async function resolveVerifyItem(id: number, resolution: 'confirmed' | 'rejected'): Promise<void> {
  await query(`UPDATE scan_events SET resolved_at = now(), resolution = $2 WHERE id = $1`, [id, resolution]);
}

/* --------------------------------------------------------------- the queues */

/** Everything the dashboard's ranking sections need, in one round-trip. */
export async function getQueues(opts: { date?: string; now?: number } = {}): Promise<{
  repos: Repo[];
  ranked: ScoredRepo[];
  queue: ScoredRepo[];
  lane: ScoredRepo[];
  batches: DbBatch[];
}> {
  const repos = await getRepos();
  return {
    repos,
    ranked: rank(repos, opts),
    queue: launchQueue(repos, opts),
    lane: agentLane(repos, opts),
    batches: dbBatches(repos, opts),
  };
}
