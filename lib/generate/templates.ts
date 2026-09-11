/**
 * generate/templates.ts — the prompt library index.
 *
 * The library itself is markdown in `templates/prompts/` (S4 fills it; O3 ships
 * two exemplars). This module only reads `index.json` and hands the generator a
 * shortlist: "here is what a good item for this situation looks like, and which
 * model it usually wants".
 *
 * Read from disk at call time rather than imported, so S4 can add a template
 * without touching code. It degrades to an empty list: a generator with no
 * library still works, it just has less to imitate (plan.md §4.5).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_MODELS, WORK_TOOLS, type WorkModel, type WorkTool } from '../domain';

export interface TemplateIndexEntry {
  key: string;
  file: string;
  /** One line: the situation this template is for. Shown to the generator. */
  when: string;
  tool_default: WorkTool;
  model_default: WorkModel;
  /** `{{placeholders}}` the generator is expected to fill in. */
  placeholders: string[];
}

export const TEMPLATE_DIR = join(process.cwd(), 'templates', 'prompts');

function isEntry(value: unknown): value is TemplateIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.key === 'string' &&
    typeof e.file === 'string' &&
    typeof e.when === 'string' &&
    WORK_TOOLS.includes(e.tool_default as WorkTool) &&
    WORK_MODELS.includes(e.model_default as WorkModel)
  );
}

export function loadTemplateIndex(dir = TEMPLATE_DIR): TemplateIndexEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = (raw as { templates?: unknown[] })?.templates ?? [];
  return list.filter(isEntry).map((e) => ({ ...e, placeholders: e.placeholders ?? [] }));
}

export function loadTemplate(key: string, dir = TEMPLATE_DIR): string | null {
  const entry = loadTemplateIndex(dir).find((t) => t.key === key);
  if (!entry) return null;
  try {
    return readFileSync(join(dir, entry.file), 'utf8');
  } catch {
    return null;
  }
}

/** Every `{{placeholder}}` actually present in a template body. */
export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]))];
}
