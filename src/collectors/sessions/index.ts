import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DB } from '../../db/index.js';
import type { Collector } from '../types.js';
import { SessionReducer, attribute, endedMidTask, heuristicSummary, type Checkout, type SessionFacts, type Tool } from './parse.js';
import { cleanTitle, taskHash } from '../../tasks/store.js';

/** Only sessions touched in this window are read; older logs cannot be "half-finished work". */
const MAX_AGE_DAYS = 90;
/** A mid-task session older than this stops being a Today candidate. */
const TASK_WINDOW_DAYS = 14;

export interface SessionRoots { claude: string; codex: string }
export const defaultRoots = (): SessionRoots => ({ claude: join(homedir(), '.claude', 'projects'), codex: join(homedir(), '.codex', 'sessions') });

export function listLogs(dir: string, now: Date): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  if (!existsSync(dir)) return out;
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86_400_000;
  const walk = (d: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { const m = statSync(p).mtimeMs; if (m >= cutoff) out.push({ path: p, mtime: m }); } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return out;
}

async function reduceFile(tool: Tool, path: string, roots: string[]): Promise<SessionFacts> {
  const r = new SessionReducer(tool, roots);
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || line.length > 5_000_000) continue;
    try { r.add(JSON.parse(line)); } catch { /* torn line while the session is still writing */ }
  }
  return r.facts;
}

/** Repo name from a GitHub remote URL of the owner's account, else null. */
export function repoFromRemote(url: string, owner: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i.exec(url.trim());
  return m && m[1].toLowerCase() === owner.toLowerCase() ? m[2] : null;
}

const sessionId = (path: string) => createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 32);

/** Branch → repo, for branches that belong to exactly one repo (from the latest GitHub snapshots). */
function branchOwners(db: DB) {
  const seen = new Map<string, Set<string>>();
  for (const row of db.prepare('SELECT repo, open_prs, stale_branches FROM latest_gh_snapshot').all() as { repo: string; open_prs: string; stale_branches: string }[]) {
    const names = [
      ...(JSON.parse(row.open_prs) as { branch?: string; headRefName?: string }[]).map(p => p.branch ?? p.headRefName),
      ...(JSON.parse(row.stale_branches) as ({ name?: string } | string)[]).map(b => (typeof b === 'string' ? b : b.name)),
    ];
    for (const n of names) if (n) { const s = seen.get(n) ?? new Set(); s.add(row.repo); seen.set(n, s); }
  }
  return new Map([...seen].filter(([, s]) => s.size === 1).map(([n, s]) => [n, [...s][0]]));
}

/**
 * Sessions that ended mid-task in the last 14 days become "Finish: …" tasks. A task closes
 * when a newer session in the same repo ended cleanly, and is dropped once it ages out.
 */
export function syncSessionTasks(db: DB, now: Date) {
  const at = now.toISOString(), window = new Date(now.getTime() - TASK_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = db.prepare('SELECT * FROM agent_sessions WHERE repo IS NOT NULL').all() as (SessionFacts & { id: string; repo: string; project_id: string | null; ended_mid_task: number; summary: string | null; cwd: string | null })[];
  const find = db.prepare('SELECT id, status FROM tasks WHERE source_hash=?');
  const insert = db.prepare(`INSERT INTO tasks(project_id,title,source_kind,source_file,source_hash,status,closeness,effort_h,created_at,repo,local_path,detail,updated_at)
    VALUES (?,?,'session',?,?,'open',0.8,1,?,?,?,?,?)`);
  const close = db.prepare("UPDATE tasks SET status=?, done_at=?, updated_at=? WHERE id=? AND status='open'");
  const latestClean = new Map<string, string>();
  for (const s of rows) if (!s.ended_mid_task && s.last_at && s.last_at > (latestClean.get(s.repo) ?? '')) latestClean.set(s.repo, s.last_at);
  let open = 0;
  db.transaction(() => {
    for (const s of rows) {
      if (!s.ended_mid_task || !s.last_at || !s.last_request) continue;
      const hash = taskHash('session', s.id);
      const existing = find.get(hash) as { id: number; status: string } | undefined;
      const superseded = (latestClean.get(s.repo) ?? '') > s.last_at;
      if (existing) {
        if (superseded) close.run('done', at, at, existing.id);
        else if (s.last_at < window) close.run('dropped', at, at, existing.id);
        continue;
      }
      if (superseded || s.last_at < window) continue;
      insert.run(s.project_id, cleanTitle(`Finish: ${s.last_request}`), `${s.tool} session`, hash, at, s.repo, s.cwd, s.summary, at);
      open++;
    }
  })();
  return open;
}

export function sessionsCollector(intervalMin = 30, roots: SessionRoots = defaultRoots()): Collector {
  return {
    name: 'sessions', intervalMin,
    async run(ctx) {
      const now = ctx.now();
      const checkouts = ctx.db.prepare('SELECT path, repo FROM latest_local_snapshot').all() as Checkout[];
      const repoProject = new Map((ctx.db.prepare('SELECT name, project_id FROM repos').all() as { name: string; project_id: string | null }[]).map(r => [r.name, r.project_id]));
      const owners = branchOwners(ctx.db);
      const known = new Map((ctx.db.prepare('SELECT id, file_mtime FROM agent_sessions').all() as { id: string; file_mtime: number }[]).map(r => [r.id, r.file_mtime]));
      const upsert = ctx.db.prepare(`INSERT INTO agent_sessions(id,tool,repo,project_id,started_at,last_at,last_request,ended_mid_task,summary,file_mtime,branch,cwd)
        VALUES (@id,@tool,@repo,@project_id,@started_at,@last_at,@last_request,@ended_mid_task,@summary,@file_mtime,@branch,@cwd)
        ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, project_id=excluded.project_id, started_at=excluded.started_at, last_at=excluded.last_at,
          last_request=excluded.last_request, ended_mid_task=excluded.ended_mid_task, summary=excluded.summary, file_mtime=excluded.file_mtime, branch=excluded.branch, cwd=excluded.cwd`);
      let read = 0;
      const remotes = new Map<string, string | null>();
      for (const [tool, dir] of [['claude', roots.claude], ['codex', roots.codex]] as const) {
        for (const file of listLogs(dir, now)) {
          const id = sessionId(file.path);
          // Unchanged files are skipped, except ones written in the last 2 hours: those were too
          // fresh to judge as ended-mid-task when last read.
          if (known.get(id) === file.mtime && now.getTime() - file.mtime > 2 * 3_600_000) continue;
          const facts = await reduceFile(tool, file.path, ctx.config.local_roots);
          if (!facts.last_at) continue;
          let who = attribute(facts, checkouts, owners);
          if (!who.repo) {
            // Worktrees, scratch copies and folders outside the roots: ask git which repo they are.
            const folders = [facts.cwd, ...Object.entries(facts.paths).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p)].filter((p): p is string => !!p);
            const extra: Checkout[] = [];
            for (const folder of folders) {
              const key = folder.toLowerCase();
              if (!remotes.has(key)) {
                let repo: string | null = null;
                if (existsSync(folder)) { try { repo = repoFromRemote(await ctx.exec('git', ['-C', folder, 'remote', 'get-url', 'origin'], { timeout: 5000 }), ctx.config.github_owner); } catch { repo = null; } }
                remotes.set(key, repo);
              }
              const repo = remotes.get(key);
              if (repo) extra.push({ path: folder, repo });
            }
            if (extra.length) who = attribute(facts, [...checkouts, ...extra], owners);
          }
          upsert.run({
            id, tool, repo: who.repo, project_id: who.repo ? repoProject.get(who.repo) ?? null : null,
            started_at: facts.started_at, last_at: facts.last_at, last_request: facts.last_request,
            ended_mid_task: endedMidTask(facts, now) ? 1 : 0, summary: heuristicSummary(facts), file_mtime: file.mtime,
            branch: facts.branch, cwd: who.path ?? facts.cwd,
          });
          read++;
        }
      }
      syncSessionTasks(ctx.db, now);
      return read;
    },
  };
}
