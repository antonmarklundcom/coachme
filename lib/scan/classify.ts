/**
 * scan/classify.ts — the judgement half of the deep scan.
 *
 * The old scan asked a Claude Code session to read a clone. This one calls the
 * Anthropic Messages API with the file contents the GitHub client fetched, using
 * a prompt adapted from SCAN.md, and keeps that document's hard rule verbatim:
 * **say nothing you did not see evidence for — omit a field rather than guess it.**
 *
 * Model: claude-sonnet-5. Never Fable — this is reading against a fixed rubric,
 * not deciding anything (SCAN.md; plan.md §4.8; the `fable-cost-guardrail` skill).
 */

import { BLOCKERS, LANES } from '../domain';
import type { ScanFinding } from './apply';
import type { CommitInfo, PullInfo } from './github';

export const SCAN_MODEL = 'claude-sonnet-5';

export function anthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

export interface ClassifyInput {
  name: string;
  recordedPct: number;
  recordedBlocker: string;
  docs: { path: string; text: string }[];
  commits: CommitInfo[];
  openPrs: PullInfo[];
  mergedPrs: PullInfo[];
}

function buildPrompt(input: ClassifyInput): string {
  const docs = input.docs.map((d) => `--- ${d.path} ---\n${d.text}`).join('\n\n') || '(no docs found)';
  const commits =
    input.commits.map((c) => `${c.date.slice(0, 10)}\t${c.message}`).join('\n') || '(no commits read)';
  const prs =
    [
      ...input.openPrs.map((p) => `open   #${p.number} ${p.title}`),
      ...input.mergedPrs.map((p) => `merged #${p.number} ${p.title}`),
    ].join('\n') || '(none)';

  return `You are the twice-weekly repo scan for antonmarklundcom/coachme. You are
reading ONE repository, "${input.name}", and reporting what you can see.

The record currently says: ${input.recordedPct}% done, blocker "${input.recordedBlocker}".

Judge each field from the evidence below. Say nothing you did not see evidence
for — OMIT a field rather than guess it. An omitted field means "the scan
learned nothing new", which is always a safe answer.

  pct             0-100, how finished the shipped PRODUCT is (not test coverage)
  last_commit     ISO date (YYYY-MM-DD) of the newest commit
  blocker         one of: ${BLOCKERS.join(', ')}
  lane            one of: ${LANES.join(', ')}
  next_step       ONE line: the very next action, and whose it is
  open_prs        count of open PRs
  merged_prs_30d  count of PRs merged in the last 30 days
  live_url        a deployed URL if the docs state one

Do NOT report live_url_ok — whether a URL answers is checked by fetching it,
not by reading about it.

=== DOCS ===
${docs}

=== RECENT COMMITS ===
${commits}

=== PULL REQUESTS ===
${prs}

Reply with a single strict JSON object containing only the fields you have
evidence for. No prose, no markdown fence.`;
}

const ALLOWED: (keyof ScanFinding)[] = [
  'pct',
  'last_commit',
  'blocker',
  'lane',
  'next_step',
  'open_prs',
  'merged_prs_30d',
  'live_url',
];

/** Keep only fields the scan is allowed to report, in the shape apply.ts expects. */
export function sanitizeFinding(raw: unknown): ScanFinding {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const out: ScanFinding = {};
  for (const key of ALLOWED) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (key === 'pct' || key === 'open_prs' || key === 'merged_prs_30d') {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      if (key === 'pct' && (n < 0 || n > 100)) continue;
      (out[key] as number) = Math.round(n);
    } else if (key === 'blocker') {
      if (BLOCKERS.includes(value as never)) out.blocker = value as string;
    } else if (key === 'lane') {
      if (LANES.includes(value as never)) out.lane = value as string;
    } else if (typeof value === 'string' && value.trim()) {
      (out[key] as string) = value.trim();
    }
  }
  return out;
}

export class ClassifierUnavailable extends Error {}

/**
 * Ask Sonnet what this repo looks like. Throws `ClassifierUnavailable` when no
 * API key is configured, which the caller downgrades to an evidence-only scan
 * (live-URL check + stack metadata) rather than failing the run — plan.md §4.5.
 */
export async function classifyRepo(input: ClassifyInput): Promise<ScanFinding> {
  const key = anthropicKey();
  if (!key) throw new ClassifierUnavailable('ANTHROPIC_API_KEY is not set');

  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SCAN_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildPrompt(input) }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = body.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return sanitizeFinding(JSON.parse(json));
  } catch {
    throw new Error(`scan model did not return JSON: ${text.slice(0, 200)}`);
  }
}
