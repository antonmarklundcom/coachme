/**
 * generate/sanitize.ts — what the generator is allowed to have said.
 *
 * The same shape as lib/scan/classify.ts's `sanitizeFinding`, for the same
 * reason: everything downstream of a model call treats the model's output as a
 * suggestion from an untrusted source. Here it matters more than in the scan,
 * because these values become a file committed to another repository.
 *
 * The rule is SCAN.md's, unchanged: **omit rather than guess**. A field that
 * does not survive validation is dropped; an item missing anything load-bearing
 * is dropped whole. Zero items is a valid answer.
 *
 * `model` is the one field that is silently corrected rather than dropped: any
 * value that is not "opus" or "sonnet" becomes "sonnet" for an agent item. A
 * model string is a cost decision (plan.md §4.8, the `fable-cost-guardrail`
 * skill), and dropping the field would leave it to a default somewhere else.
 */

import {
  STAGES,
  WORK_KINDS,
  WORK_MODELS,
  WORK_TOOLS,
  isSlug,
  toSlug,
  type Stage,
  type WorkKind,
  type WorkModel,
  type WorkTool,
} from '../domain';

/** At most three: a desk that proposes ten things is a backlog, not a desk. */
export const MAX_ITEMS = 3;
const MAX_TITLE = 120;
const MAX_PROMPT = 20_000;
const MAX_ESTIMATE = 480;

export interface GeneratedItem {
  slug: string;
  title: string;
  kind: WorkKind;
  tool: WorkTool;
  model: WorkModel | null;
  stage_target: Stage;
  estimate_minutes: number | null;
  prompt_md: string;
}

export interface GeneratedPlan {
  stage_suggestion: Stage | null;
  items: GeneratedItem[];
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function sanitizeItem(raw: unknown): GeneratedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  const title = text(input.title, MAX_TITLE);
  const prompt = text(input.prompt_md, MAX_PROMPT);
  if (!title || !prompt) return null;

  // A slug the model got wrong is recoverable from the title; a missing one is
  // not a reason to throw away a good item.
  const proposed = typeof input.slug === 'string' ? toSlug(input.slug) : '';
  const slug = isSlug(proposed) ? proposed : toSlug(title);
  if (!isSlug(slug)) return null;

  const kind = WORK_KINDS.includes(input.kind as WorkKind) ? (input.kind as WorkKind) : null;
  if (!kind) return null;

  const stage_target = STAGES.includes(input.stage_target as Stage) ? (input.stage_target as Stage) : null;
  if (!stage_target) return null;

  const toolRaw = WORK_TOOLS.includes(input.tool as WorkTool) ? (input.tool as WorkTool) : null;
  // An owner item is for the owner whatever the model called it, and an agent
  // item is never "owner" — the two fields are one fact stated twice.
  const tool: WorkTool = kind === 'owner' ? 'owner' : toolRaw && toolRaw !== 'owner' ? toolRaw : 'either';

  const model: WorkModel | null =
    kind === 'owner' ? null : WORK_MODELS.includes(input.model as WorkModel) ? (input.model as WorkModel) : 'sonnet';

  let estimate: number | null = null;
  if (kind === 'owner') {
    const n = Number(input.estimate_minutes);
    estimate = Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_ESTIMATE) : null;
  }

  return { slug, title, kind, tool, model, stage_target, estimate_minutes: estimate, prompt_md: prompt };
}

export function sanitizePlan(raw: unknown, { exclude = [] }: { exclude?: string[] } = {}): GeneratedPlan {
  const input = (raw ?? {}) as Record<string, unknown>;
  const stage_suggestion = STAGES.includes(input.stage_suggestion as Stage)
    ? (input.stage_suggestion as Stage)
    : null;

  const seen = new Set(exclude);
  const items: GeneratedItem[] = [];
  for (const candidate of Array.isArray(input.items) ? input.items : []) {
    if (items.length >= MAX_ITEMS) break;
    const item = sanitizeItem(candidate);
    if (!item || seen.has(item.slug)) continue;
    seen.add(item.slug);
    items.push(item);
  }

  return { stage_suggestion, items };
}

/** Pull the JSON object out of whatever the model wrapped it in. */
export function parsePlanText(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`generator did not return JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}
