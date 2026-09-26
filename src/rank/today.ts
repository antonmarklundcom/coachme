import type { TaskRow } from '../tasks/store.js';
import { DEFAULT_CLOSENESS, DEFAULT_EFFORT } from '../tasks/store.js';

/**
 * Closeness to money by stage. Ported from v3's money-distance ranking (v3 lib/score.ts, in git history):
 * a project's stage says how near it is to earning; inside one stage, how close the task is
 * to done decides.
 */
export const STAGE_FACTOR: Record<string, number> = { earning: 1.0, live: 0.9, deployed: 0.7, building: 0.5, planned: 0.2, idea: 0.1 };

export interface ProjectInfo { id: string; name: string; stage: string; money_weight: number }
export interface Candidate {
  task: TaskRow;
  project: ProjectInfo | null;
  redAlert: boolean;       // the task's project has an open red alert
  lastActivity: number;    // epoch ms of the project's last commit or session, 0 when unknown
}
export interface Ranked extends Candidate { score: number; money: number; closeness: number; effort: number }

export const money = (p: ProjectInfo | null) => (p ? Math.max(1, p.money_weight) * (STAGE_FACTOR[p.stage] ?? 0.2) : 0.2);
export const closeness = (t: TaskRow) => Math.min(1, Math.max(0.05, t.closeness ?? DEFAULT_CLOSENESS[t.source_kind] ?? 0.5));
export const effort = (t: TaskRow) => Math.max(0.25, t.effort_h ?? DEFAULT_EFFORT[t.source_kind] ?? 1);

/** score = money × closeness ÷ effort, +50% when the project has an open red alert. */
export function score(c: Candidate): Ranked {
  const m = money(c.project), cl = closeness(c.task), e = effort(c.task);
  return { ...c, money: m, closeness: cl, effort: e, score: (m * cl / e) * (c.redAlert ? 1.5 : 1) };
}

const eligible = (c: Candidate) => c.task.status === 'open' && !(c.project && (c.project.stage === 'paused' || c.project.stage === 'killed'));
const byScore = (a: Ranked, b: Ranked) => b.score - a.score || b.lastActivity - a.lastActivity || a.task.id - b.task.id;

/** Every eligible candidate, best first. */
export function ranked(candidates: Candidate[]): Ranked[] { return candidates.filter(eligible).map(score).sort(byScore); }

/** The top n for the AI to reorder; it may never add anything outside this list. */
export const topCandidates = (candidates: Candidate[], n = 10) => ranked(candidates).slice(0, n);

/**
 * The day's actions: pinned tasks take slots first, then by score, at most `perProject`
 * from one project so a single stuck project cannot take the whole day.
 */
export function pickToday(list: Ranked[], limit = 3, perProject = 2): Ranked[] {
  const out: Ranked[] = [], per = new Map<string, number>();
  const take = (r: Ranked) => {
    const key = r.project?.id ?? `task:${r.task.id}`;
    if (out.length >= limit || (per.get(key) ?? 0) >= perProject || out.includes(r)) return;
    out.push(r); per.set(key, (per.get(key) ?? 0) + 1);
  };
  list.filter(r => r.task.pinned).forEach(take);
  list.forEach(take);
  return out;
}

export const rankToday = (candidates: Candidate[], limit = 3) => pickToday(ranked(candidates), limit);

/** Apply an AI ordering of task ids, rejecting it when it names any id outside the candidates. */
export function applyOrder(list: Ranked[], order: number[] | null | undefined): Ranked[] | null {
  if (!order?.length) return null;
  const byId = new Map(list.map(r => [r.task.id, r]));
  if (order.some(id => !byId.has(id)) || new Set(order).size !== order.length || order.length < Math.min(3, list.length)) return null;
  const rest = list.filter(r => !order.includes(r.task.id));
  return [...order.map(id => byId.get(id)!), ...rest];
}

const ago = (ms: number, now: Date) => {
  const d = Math.floor((now.getTime() - ms) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `about ${h % 1 ? h.toFixed(1) : h} h`);

/** A plain reason built from the numbers, used whenever the AI is off or declined. */
export function deterministicReason(r: Ranked, now: Date): string {
  const parts: string[] = [];
  if (r.project) parts.push(`${r.project.stage} project`);
  if (r.redAlert) parts.push('site has a red alert');
  const source: Record<string, string> = {
    session: `an agent session stopped mid-task${r.task.created_at ? ` (${ago(Date.parse(r.task.created_at), now)})` : ''}`,
    handoff: 'next step from a HANDOFF note', 'plan-phase': `current plan phase${r.task.detail ? `: ${r.task.detail}` : ''}`,
    'known-issue': 'listed in KNOWN-ISSUES', todo: 'TODO in the code', inbox: 'from your inbox', manual: 'added by you', alert: 'fixes an alert',
  };
  parts.push(source[r.task.source_kind] ?? r.task.source_kind);
  parts.push(hours(r.effort));
  return parts.join(' · ');
}

/** Projects nearest to earning: stage factor × money weight, then most recently active. */
export function closestToMoney<T extends ProjectInfo & { lastActivity?: number }>(projects: T[], n = 5): T[] {
  return projects.filter(p => p.stage !== 'paused' && p.stage !== 'killed')
    .sort((a, b) => money(b) - money(a) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.name.localeCompare(b.name)).slice(0, n);
}
