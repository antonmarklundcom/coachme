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
  type ClearedBlocker,
  type Lane,
  type Repo,
  unblockedLane,
} from './domain';
import { localDate, safeTimeZone } from './clock';
import type { NudgeOutcome, NudgeRecord, NudgeType } from './nudge/history';
import type { OwnerAction } from './nudge/outcomes';
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

/** Whatever `pg` handed back for a timestamp, as an ISO string. */
function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

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
 *
 * The date defaults to the OWNER's day, not UTC's. It is read back by the nudge
 * engine (getOwnerActions) and compared against `nudges.local_date`, so a tick
 * at 21:30 in Asunción has to be today's tick, not tomorrow's.
 */
export async function clearBlocker(
  repo: Repo,
  blocker: Blocker,
  { date }: { date?: string } = {}
): Promise<void> {
  const on = date ?? localDate(Date.now(), safeTimeZone((await getSettings()).owner_timezone));
  if (repo.blocker !== blocker) {
    throw new Error(`repo "${repo.name}" is blocked on "${repo.blocker}", not "${blocker}"`);
  }
  await updateRepo(repo.id, {
    cleared_blockers: [...repo.cleared_blockers, { blocker, date: on }],
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
  /** Both already selected by `SELECT *`; the inbox rung reads created_at to
   *  decide whether one item is old enough to nudge on its own. */
  created_at: string;
  resolved_at: string | null;
}

/**
 * `created_at` and `resolved_at` come back as ISO strings, not `pg`'s parsed
 * `Date`. The inbox rung slices `created_at` to a day and does arithmetic on
 * it; a `Date` stringifies to "Fri Aug 28 2026 …", whose first ten characters
 * are "Fri Aug 28" — which parses to NaN and makes every comparison silently
 * false. The coach would simply stop mentioning the inbox, and nothing would
 * error.
 */
export async function getDecisions(status?: Decision['status']): Promise<Decision[]> {
  const rows = status
    ? await query(`SELECT * FROM decisions WHERE status = $1 ORDER BY id`, [status])
    : await query(`SELECT * FROM decisions ORDER BY id`);
  return rows.map((row) => ({
    ...row,
    created_at: asIso(row.created_at),
    resolved_at: row.resolved_at ? asIso(row.resolved_at) : null,
  })) as unknown as Decision[];
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
  return rows.map((row) => ({ ...row, created_at: asIso(row.created_at) })) as unknown as VerifyItem[];
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

/* -------------------------------------------------------------------- nudges */

/**
 * The nudge history, oldest first — the order lib/nudge/history.ts walks
 * backwards from. Ordered by (local_date, id) so two rows written on the same
 * day keep their insertion order, which is what the chain counter relies on.
 */
export async function getNudges(): Promise<NudgeRecord[]> {
  const rows = await query(
    `SELECT id, to_char(local_date, 'YYYY-MM-DD') AS local_date, type, repo_names,
            outcome, pushed, shrunk, parent_type, title, body, note
     FROM nudges ORDER BY local_date, id`
  );
  return rows.map((row) => ({
    ...row,
    repo_names: (row.repo_names as string[]) ?? [],
  })) as unknown as NudgeRecord[];
}

export interface NudgeInput {
  local_date: string;
  type: NudgeType;
  repo_names: string[];
  pushed: boolean;
  shrunk?: boolean;
  parent_type?: string | null;
  title?: string | null;
  body?: string | null;
  note?: string | null;
}

export async function recordNudge(nudge: NudgeInput): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO nudges (local_date, type, repo_names, pushed, shrunk, parent_type, title, body, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      nudge.local_date,
      nudge.type,
      JSON.stringify(nudge.repo_names),
      nudge.pushed,
      nudge.shrunk ?? false,
      nudge.parent_type ?? null,
      nudge.title ?? null,
      nudge.body ?? null,
      nudge.note ?? null,
    ]
  );
  return row!.id;
}

export async function setNudgeOutcome(
  id: number,
  outcome: NudgeOutcome,
  evidence: string | null = null
): Promise<void> {
  await query(
    `UPDATE nudges SET outcome = $2, note = COALESCE($3, note) WHERE id = $1`,
    [id, outcome, evidence]
  );
}

/**
 * What the owner has actually done lately, as lib/nudge/outcomes.ts wants it.
 *
 * Every source here is a *deliberate* owner action — a ticked box, an answered
 * question — never a scan result. That is the drift-guard principle from
 * SCAN.md ("a scan is an estimate, a tick is a fact") applied to the nudge
 * engine: a scan noticing a repo moved must not be able to tell the coach the
 * owner responded to its nudge.
 *
 * Timestamps are collapsed to a day in the OWNER's timezone, because that is
 * the calendar `nudges.local_date` is kept in. Reading them as UTC days would
 * post-date every evening tick by one day in Asunción (UTC-3) and let it
 * resolve the *next* morning's nudge as "acted" — quietly clearing an
 * escalation chain, a cooldown and a shrink counter the owner never touched.
 */
export async function getOwnerActions(since: string, timezone: string): Promise<OwnerAction[]> {
  const actions: OwnerAction[] = [];

  // A ticked "besikt DB done" box, recorded with its date by clearBlocker().
  const cleared = await query<{ name: string; cleared_blockers: ClearedBlocker[] }>(
    `SELECT name, cleared_blockers FROM repos WHERE jsonb_array_length(cleared_blockers) > 0`
  );
  for (const row of cleared) {
    for (const entry of row.cleared_blockers ?? []) {
      if (entry.date && entry.date >= since) {
        actions.push({ repo: row.name, date: entry.date, what: `cleared ${entry.blocker}` });
      }
    }
  }

  // A scope-review answer: keep, snooze, or kill.
  const scoped = await query<{ name: string; date: string; what: string }>(
    `SELECT name, to_char(kept_at, 'YYYY-MM-DD') AS date, 'kept in scope' AS what
       FROM repos WHERE kept_at >= $1::date
     UNION ALL
     SELECT name, to_char(killed_at, 'YYYY-MM-DD'), 'killed'
       FROM repos WHERE killed_at >= $1::date`,
    [since]
  );
  actions.push(...scoped.map((r) => ({ repo: r.name, date: r.date, what: r.what })));

  // An answered inbox item — no single repo behind it, so it resolves the
  // decisions nudge, which names none either.
  const decided = await query<{ date: string }>(
    `SELECT to_char(resolved_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date
     FROM decisions WHERE resolved_at >= $1::date`,
    [since, timezone]
  );
  actions.push(...decided.map((r) => ({ repo: null, date: r.date, what: 'answered a decision' })));

  // A settled drift-guard verify item.
  const verified = await query<{ name: string | null; date: string }>(
    `SELECT r.name, to_char(e.resolved_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date
     FROM scan_events e LEFT JOIN repos r ON r.id = e.repo_id
     WHERE e.resolved_at >= $1::date`,
    [since, timezone]
  );
  actions.push(...verified.map((r) => ({ repo: r.name, date: r.date, what: 'settled a verify item' })));

  return actions;
}

/** Merge keys into `settings.session_state` without clobbering the rest of it. */
export async function patchSessionState(patch: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE settings SET session_state = session_state || $1::jsonb, updated_at = now() WHERE id = TRUE`,
    [JSON.stringify(patch)]
  );
}

/* ------------------------------------------------------- push subscriptions */

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  keys: { p256dh?: string; auth?: string };
}

export async function getPushSubscriptions(): Promise<PushSubscriptionRow[]> {
  return (await query(
    `SELECT id, endpoint, keys FROM push_subscriptions ORDER BY id`
  )) as unknown as PushSubscriptionRow[];
}

/** Re-subscribing the same browser refreshes its keys rather than duplicating it. */
export async function savePushSubscription(
  endpoint: string,
  keys: Record<string, string>
): Promise<void> {
  await query(
    `INSERT INTO push_subscriptions (endpoint, keys) VALUES ($1, $2)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys`,
    [endpoint, JSON.stringify(keys)]
  );
}

/** A 404/410 from the push service means the browser threw the subscription away. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

/* ----------------------------------------------------------- chat grounding */

/** The last few scan results for one repo — context for the read-only chat panel. */
export async function getRecentScanEvents(repoId: number, limit = 5): Promise<
  { created_at: string; applied: boolean; verify_reason: string | null; findings: Record<string, unknown> }[]
> {
  return (await query(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS created_at, applied, verify_reason, findings
     FROM scan_events WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [repoId, limit]
  )) as unknown as {
    created_at: string;
    applied: boolean;
    verify_reason: string | null;
    findings: Record<string, unknown>;
  }[];
}

export async function getRepoById(id: number): Promise<Repo | null> {
  const row = await one(`SELECT ${REPO_COLUMNS} FROM repos WHERE id = $1`, [id]);
  return row ? normalize(row) : null;
}
