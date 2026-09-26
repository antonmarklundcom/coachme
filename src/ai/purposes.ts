import * as z from 'zod/v4';
import { ask, type AiDeps } from './client.js';
import { redact } from '../lib/redact.js';
import type { Ranked } from '../rank/today.js';

/**
 * The four AI uses the plan allows (PLAN.md §7). Everything sent is already redacted text
 * the app stores anyway; nothing here reads raw logs or files.
 */

const Rerank = z.object({ order: z.array(z.object({ id: z.number().int(), reason: z.string().max(200) })).max(10) });

/** Reorder the deterministic top candidates and give each a one-sentence reason. */
export async function rerankToday(deps: AiDeps, candidates: Ranked[], day: string) {
  if (candidates.length < 2) return null;
  const input = {
    day,
    rule: 'Pick the order that makes Anton the most money soonest: live and earning sites first, then work closest to done. Reason: one plain sentence, max 25 words, no hype.',
    candidates: candidates.map(c => ({
      id: c.task.id, task: redact(c.task.title), detail: c.task.detail ? redact(c.task.detail) : null, source: c.task.source_kind,
      project: c.project?.name ?? null, stage: c.project?.stage ?? null, money_weight: c.project?.money_weight ?? null,
      red_alert: c.redAlert, effort_hours: c.effort, score: Math.round(c.score * 100) / 100,
    })),
  };
  return ask(deps, {
    purpose: 'today', maxTokens: 1500, schema: Rerank, input,
    system: 'You rank a solo founder\'s daily actions. Return every candidate id you keep, best first, only ids from the input. Reasons are concrete and short.',
  });
}

const Summary = z.object({ summary: z.string().max(300) });
/** Summarise a session from its redacted facts (title, last request, last reply). */
export async function summarizeSession(deps: AiDeps, facts: { title: string | null; last_request: string | null; summary: string | null; repo: string | null }) {
  return ask(deps, {
    purpose: 'session-summary', maxTokens: 400, schema: Summary, input: facts,
    system: 'Summarise where this coding-agent session stopped in one or two sentences (max 300 characters): what it was doing and what is left. Plain words.',
  });
}

const Goal = z.object({ goal: z.string().max(800) });
/** Turn a terse task into a clear goal paragraph for a coding agent. The header and DoD stay deterministic. */
export async function polishGoal(deps: AiDeps, task: { title: string; detail: string | null; source_kind: string; project: string | null }) {
  return ask(deps, {
    purpose: 'goal', maxTokens: 600, schema: Goal, input: task,
    system: 'Rewrite this task as a clear goal paragraph (2-4 sentences) for a coding agent working in the repo. Do not invent facts, file names or requirements that are not in the input.',
  });
}

const Weekly = z.object({ headline: z.string().max(200), body: z.string().max(3000) });
/** Weekly review prose over the deterministic facts (phase 5 wires the schedule). */
export async function writeWeekly(deps: AiDeps, facts: unknown) {
  return ask(deps, {
    purpose: 'weekly', maxTokens: 2500, schema: Weekly, input: facts,
    system: 'Write a short weekly review for a solo founder from these facts: shipped, broke, earned, stalled, suggested kills. Direct, specific, no filler. Use only the facts given.',
  });
}
