import type { TaskRow } from '../tasks/store.js';

/**
 * The copy-prompt: a ready-to-paste Claude Code / Codex prompt for one task. The header and
 * the definition of done are always deterministic (ported from v3's mandatory header in
 * v3 lib/generate/prompt.ts, in git history); only the goal paragraph may be polished by the AI.
 */
export interface PromptInput {
  task: Pick<TaskRow, 'title' | 'source_kind' | 'source_file' | 'source_line' | 'detail' | 'repo' | 'local_path'>;
  projectName?: string | null;
  githubOwner: string;
  domains?: string[];
  goal?: string | null;   // AI-polished goal paragraph; falls back to the task title and detail
}

const DONE: Record<string, string[]> = {
  'known-issue': ['The issue is fixed, and its entry is removed from KNOWN-ISSUES.md (or moved under a resolved heading).'],
  handoff: ['The step is done, and it is ticked or removed in the HANDOFF note.'],
  'plan-phase': ['The item is implemented and its checkbox is ticked in the plan file.'],
  todo: ['The TODO is resolved and the comment is removed.'],
  session: [
    'Before changing anything, read git status, git log -5 and the diff to see where the previous session stopped.',
    'The work that session was doing is finished and committed on a branch.',
  ],
  alert: ['The site answers 200 with its real page again, checked with a real request.'],
  inbox: ['The request is done as described.'],
  manual: ['The request is done as described.'],
};
const COMMON = [
  "The repo's own build and tests pass (run them; do not skip any).",
  'Nothing outside this task changed.',
];

export const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^(finish|todo):\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'task';

export function buildPrompt(input: PromptInput): string {
  const { task } = input;
  const s = slug(task.title);
  const repoLine = [task.local_path ?? '(not cloned on this PC)', task.repo ? `github ${input.githubOwner}/${task.repo}` : null].filter(Boolean).join(' · ');
  const source = task.source_file ? `${task.source_file}${task.source_line ? `:${task.source_line}` : ''}` : task.source_kind;
  const goal = input.goal?.trim() || [task.title, task.detail].filter(Boolean).join('\n');
  const done = [...(DONE[task.source_kind] ?? DONE.manual), ...COMMON];
  return [
    `Repo: ${repoLine}`,
    'Read AGENTS.md and CLAUDE.md in that repo first and follow them.',
    input.projectName ? `Project: ${input.projectName}${input.domains?.length ? ` (${input.domains.join(', ')})` : ''}` : null,
    '',
    'Goal:',
    goal,
    '',
    `Source: ${source}`,
    '',
    'Definition of done:',
    ...done.map(d => `- ${d}`),
    '',
    `Branch: claude/${s} (or codex/${s} if you are Codex). Do not push to main.`,
    'Stop and report: files changed, what you verified by running it, and anything skipped or uncertain.',
  ].filter(line => line !== null).join('\n');
}
