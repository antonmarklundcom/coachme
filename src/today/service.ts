import type { DB } from '../db/index.js';
import type { TaskRow } from '../tasks/store.js';
import { applyOrder, closestToMoney, deterministicReason, pickToday, ranked, type Candidate, type ProjectInfo, type Ranked } from '../rank/today.js';
import { buildPrompt } from '../prompts/build.js';
import { aiStatus, type AiDeps, type AiStatus } from '../ai/client.js';
import { polishGoal, rerankToday } from '../ai/purposes.js';

export interface TodayAction { task: TaskRow; project: ProjectInfo | null; reason: string; aiReason: boolean; prompt: string; score: number; effort: number }
export interface TodayView {
  actions: TodayAction[];
  closest: (ProjectInfo & { lastActivity: number })[];
  openTasks: number;
  unattributedSessions: number;
  ai: AiStatus;
}

/** Owner-timezone calendar day, e.g. 2026-09-26. */
export const dayKey = (now: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);

/** Epoch ms of each project's last commit or agent session. */
export function lastActivity(db: DB): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (id: string | null, iso: string | null) => { const t = Date.parse(iso ?? ''); if (id && Number.isFinite(t) && t > (out.get(id) ?? 0)) out.set(id, t); };
  for (const r of db.prepare('SELECT r.project_id, s.last_commit_at, s.last_push_at FROM repos r JOIN latest_gh_snapshot s ON s.repo=r.name').all() as { project_id: string | null; last_commit_at: string | null; last_push_at: string | null }[]) bump(r.project_id, r.last_commit_at ?? r.last_push_at);
  for (const s of db.prepare('SELECT project_id, MAX(last_at) AS last_at FROM agent_sessions GROUP BY project_id').all() as { project_id: string | null; last_at: string | null }[]) bump(s.project_id, s.last_at);
  return out;
}

/** Projects with an open red alert on one of their domains. */
export function redProjects(db: DB): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT d.project_id FROM alerts a JOIN domains d ON a.subject = 'domain:' || d.host
    WHERE a.closed_at IS NULL AND a.severity='red' AND d.project_id IS NOT NULL`).all() as { project_id: string }[];
  return new Set(rows.map(r => r.project_id));
}

export function candidates(db: DB): Candidate[] {
  const projects = new Map((db.prepare('SELECT id, name, stage, money_weight FROM projects').all() as ProjectInfo[]).map(p => [p.id, p]));
  const activity = lastActivity(db), red = redProjects(db);
  return (db.prepare("SELECT * FROM tasks WHERE status='open'").all() as TaskRow[]).map(task => ({
    task, project: task.project_id ? projects.get(task.project_id) ?? null : null,
    redAlert: !!task.project_id && red.has(task.project_id), lastActivity: task.project_id ? activity.get(task.project_id) ?? 0 : 0,
  }));
}

export interface TodayDeps { db: DB; ai: AiDeps; githubOwner: string; timeZone: string; now: () => Date }

export async function buildToday(deps: TodayDeps, limit = 3): Promise<TodayView> {
  const { db } = deps, now = deps.now();
  const all = ranked(candidates(db));
  const top = all.slice(0, 10);
  const ai = await rerankToday(deps.ai, top, dayKey(now, deps.timeZone));
  const applied = applyOrder(top, ai?.order.map(o => o.id));
  // A rejected AI order is discarded whole: its reasons would not match the fallback order.
  const reasons = new Map(applied ? ai!.order.map(o => [o.id, o.reason]) : []);
  const ordered = applied ?? top;
  // The AI orders the top 10; everything below follows in score order, so the per-project cap
  // and pinned tasks outside the top 10 can still fill all slots.
  const picked = pickToday([...ordered, ...all.filter(r => !top.includes(r))], limit);
  const domains = db.prepare('SELECT host FROM domains WHERE project_id=? ORDER BY host');
  const actions: TodayAction[] = [];
  for (const r of picked) {
    const goal = await polishGoal(deps.ai, { title: r.task.title, detail: r.task.detail, source_kind: r.task.source_kind, project: r.project?.name ?? null });
    const hosts = r.project ? (domains.all(r.project.id) as { host: string }[]).map(d => d.host) : [];
    actions.push({
      task: r.task, project: r.project, score: r.score, effort: r.effort,
      reason: reasons.get(r.task.id) ?? deterministicReason(r as Ranked, now), aiReason: reasons.has(r.task.id),
      prompt: buildPrompt({ task: r.task, projectName: r.project?.name, githubOwner: deps.githubOwner, domains: hosts, goal: goal?.goal }),
    });
  }
  const activity = lastActivity(db);
  const projects = (db.prepare('SELECT id, name, stage, money_weight FROM projects').all() as ProjectInfo[]).map(p => ({ ...p, lastActivity: activity.get(p.id) ?? 0 }));
  return {
    actions, closest: closestToMoney(projects), openTasks: all.length,
    unattributedSessions: (db.prepare('SELECT count(*) AS n FROM agent_sessions WHERE repo IS NULL AND last_at >= ?').get(new Date(now.getTime() - 14 * 86_400_000).toISOString()) as { n: number }).n,
    ai: aiStatus(deps.ai),
  };
}
