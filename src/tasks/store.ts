import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import { redact } from '../lib/redact.js';

export const SOURCE_KINDS = ['known-issue', 'handoff', 'plan-phase', 'todo', 'session', 'inbox', 'manual', 'alert'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

/** Default closeness to done (0–1) by where a task came from. PLAN.md §6 Ranking. */
export const DEFAULT_CLOSENESS: Record<SourceKind, number> = {
  handoff: 0.9, session: 0.8, 'plan-phase': 0.6, 'known-issue': 0.5, inbox: 0.5, manual: 0.5, todo: 0.3, alert: 0.9,
};
/** Default effort in hours by source. */
export const DEFAULT_EFFORT: Record<SourceKind, number> = {
  handoff: 1, session: 1, 'plan-phase': 1.5, 'known-issue': 1, inbox: 1, manual: 1, todo: 1, alert: 0.5,
};

export interface SourceTask {
  title: string;
  source_kind: SourceKind;
  source_file: string;
  source_line: number;
  detail?: string;
  closeness?: number;
}
export interface TaskScope { local_path: string; repo: string | null; project_id: string | null; kinds: SourceKind[] }

export interface TaskRow {
  id: number; project_id: string | null; title: string; source_kind: SourceKind; source_file: string | null;
  source_line: number | null; source_hash: string | null; status: 'open' | 'done' | 'dropped'; money_impact: number | null;
  closeness: number | null; effort_h: number | null; pinned: number; created_at: string; done_at: string | null;
  repo: string | null; local_path: string | null; detail: string | null; updated_at: string | null;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
export const cleanTitle = (text: string, max = 140) => {
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
export const taskHash = (...parts: string[]) => createHash('sha256').update(parts.map(normalize).join('\u0000')).digest('hex').slice(0, 32);

/**
 * Reconcile the tasks read from one checkout's files with what is stored: new items are
 * inserted, moved lines are updated, and open tasks whose source text disappeared are
 * closed as done. A task Anton closed or dropped is never reopened by a re-read.
 */
export function syncSourceTasks(db: DB, scope: TaskScope, items: SourceTask[], now: Date) {
  const at = now.toISOString();
  const seen = new Set<string>();
  let added = 0, closed = 0;
  const find = db.prepare('SELECT id, status FROM tasks WHERE source_hash = ?');
  const insert = db.prepare(`INSERT INTO tasks(project_id,title,source_kind,source_file,source_line,source_hash,status,closeness,effort_h,created_at,repo,local_path,detail,updated_at)
    VALUES (@project_id,@title,@source_kind,@source_file,@source_line,@source_hash,'open',@closeness,@effort_h,@at,@repo,@local_path,@detail,@at)`);
  const update = db.prepare('UPDATE tasks SET source_line=?, project_id=?, repo=?, detail=?, closeness=COALESCE(?,closeness), updated_at=? WHERE id=?');
  db.transaction(() => {
    for (const item of items) {
      const hash = taskHash(scope.local_path, item.source_kind, item.source_file, item.title);
      if (seen.has(hash)) continue;
      seen.add(hash);
      const title = cleanTitle(item.title);
      const detail = item.detail ? cleanTitle(item.detail, 300) : null;
      const existing = find.get(hash) as { id: number; status: string } | undefined;
      if (existing) { update.run(item.source_line, scope.project_id, scope.repo, detail, item.closeness ?? null, at, existing.id); continue; }
      insert.run({
        project_id: scope.project_id, title, source_kind: item.source_kind, source_file: item.source_file, source_line: item.source_line,
        source_hash: hash, closeness: item.closeness ?? DEFAULT_CLOSENESS[item.source_kind], effort_h: DEFAULT_EFFORT[item.source_kind],
        at, repo: scope.repo, local_path: scope.local_path, detail,
      });
      added++;
    }
    const open = db.prepare(`SELECT id, source_hash FROM tasks WHERE status='open' AND local_path=? AND source_kind IN (${scope.kinds.map(() => '?').join(',')})`)
      .all(scope.local_path, ...scope.kinds) as { id: number; source_hash: string }[];
    const close = db.prepare("UPDATE tasks SET status='done', done_at=?, updated_at=? WHERE id=?");
    for (const task of open) if (!seen.has(task.source_hash)) { close.run(at, at, task.id); closed++; }
  })();
  return { added, closed };
}

export function setTaskStatus(db: DB, id: number, status: 'open' | 'done' | 'dropped', now: Date) {
  const at = now.toISOString();
  return db.prepare('UPDATE tasks SET status=?, done_at=?, updated_at=? WHERE id=?').run(status, status === 'open' ? null : at, at, id).changes > 0;
}

export function addManualTask(db: DB, input: { project_id: string | null; title: string; source_kind?: 'inbox' | 'manual'; repo?: string | null; local_path?: string | null }, now: Date) {
  const at = now.toISOString(), kind = input.source_kind ?? 'manual';
  const result = db.prepare(`INSERT INTO tasks(project_id,title,source_kind,source_hash,status,closeness,effort_h,created_at,repo,local_path,updated_at)
    VALUES (?,?,?,?, 'open', ?, ?, ?, ?, ?, ?)`).run(input.project_id, cleanTitle(input.title), kind, taskHash(kind, input.title, at), DEFAULT_CLOSENESS[kind], DEFAULT_EFFORT[kind], at, input.repo ?? null, input.local_path ?? null, at);
  return Number(result.lastInsertRowid);
}
