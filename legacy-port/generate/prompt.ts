/**
 * generate/prompt.ts — what the generator is told, and what every dispatched
 * agent reads first.
 *
 * Two prompts live here and they point in opposite directions:
 *
 *   SYSTEM + buildPrompt()  — what coachme asks Sonnet: "look at this repo and
 *                             propose at most three pieces of work".
 *   promptHeader()          — what coachme puts at the top of each proposal, to
 *                             be read by a Claude Code or Codex session in the
 *                             TARGET repo days later, with none of this context.
 *
 * The header is the contract of the whole dispatch mechanism (Decision D-E): the
 * branch name is how the scan finds the work again (D-G), the PR title marker is
 * the fallback when the branch was renamed, and "read AGENTS.md and CLAUDE.md
 * first" is what stops a generated prompt from overriding a repo's own rules.
 * It is written ONCE, here, and tested to be the prefix of every generated item
 * — a generator that could emit an item without it could emit work nothing can
 * track.
 *
 * Model: claude-sonnet-5, through lib/anthropic.ts. Never Fable (plan.md §4.8,
 * the `fable-cost-guardrail` skill).
 */

import {
  STAGES,
  WORK_TOOLS,
  branchFor,
  oneLinerFor,
  promptPathFor,
  type Repo,
  type Stage,
  type WorkKind,
  type WorkModel,
  type WorkTool,
} from '../domain';
import type { Stack } from '../queries';
import type { PullInfo } from '../scan/github';
import type { TemplateIndexEntry } from './templates';

export interface HeaderContext {
  slug: string;
  title: string;
  kind: WorkKind;
  tool: WorkTool;
  model: WorkModel | null;
  stage_target: Stage;
  repoFullName: string;
  estimate_minutes?: number | null;
}

const TOOL_LABEL: Record<WorkTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  either: 'Claude Code or Codex',
  owner: 'Anton, by hand',
};

/**
 * The mandatory header. Byte-for-byte the prefix of every `prompt_md` this app
 * stores, agent or owner — `hasHeader()` is how that is checked, and
 * tests/generate.test.ts pins it.
 *
 * Owner items get the same block minus the branch and PR lines: an owner step
 * has no branch, and a header that told Anton to open a PR for "phone Hostinger
 * support" would be the kind of nonsense that teaches you to skip headers.
 */
export function promptHeader(ctx: HeaderContext): string {
  const lines = [
    `# ${ctx.title}`,
    '',
    `**Repo:** ${ctx.repoFullName}`,
    `**Work item:** \`${ctx.slug}\` · target stage \`${ctx.stage_target}\``,
    `**For:** ${TOOL_LABEL[ctx.tool]}${ctx.model ? ` (model: ${ctx.model})` : ''}`,
  ];

  if (ctx.kind === 'agent') {
    lines.push(
      `**Branch:** \`${branchFor(ctx.slug)}\` — create it from the default branch.`,
      `**PR title:** \`[coachme:${ctx.slug}] ${ctx.title}\``,
      '',
      'Read `AGENTS.md` and `CLAUDE.md` in this repository first. Where they and',
      'this file disagree, they win. Do only the work below; if you find other',
      'problems, write them in the PR body instead of fixing them.',
      '',
      'When every exit criterion below passes: open the PR and stop.'
    );
  } else {
    lines.push(
      `**This one is yours**${ctx.estimate_minutes ? ` — about ${ctx.estimate_minutes} minutes` : ''}.`,
      '',
      'No branch, no PR: tick it off in coachme when it is done.'
    );
  }

  lines.push('', '---', '');
  return lines.join('\n');
}

/** Is this stored prompt still the one the header contract describes? */
export function hasHeader(promptMd: string, ctx: HeaderContext): boolean {
  return promptMd.startsWith(promptHeader(ctx));
}

/** Header + body, without doubling the header if the model already wrote one. */
export function withHeader(body: string, ctx: HeaderContext): string {
  const header = promptHeader(ctx);
  const cleaned = body.replace(/^#\s.*\n+/, (m) => (m.trim() === `# ${ctx.title}` ? '' : m)).trimStart();
  return `${header}${cleaned}\n`;
}

/* ------------------------------------------------------------- the request */

export const SYSTEM = `You are the work generator for antonmarklundcom/coachme, a
launch desk for a one-person portfolio of ~61 repositories. Your output is work
items: a title and a complete prompt body that a Claude Code or Codex session
will execute in the target repository with no other context, or a short step the
owner does by hand.

The owner's scarce resource is his own attention, not agent time. Prefer work an
agent can finish alone. Reserve "owner" items for things that genuinely cannot be
delegated: a credential, a payment account, a decision only he can make, a phone
call.

Say nothing you did not see evidence for — OMIT an item rather than guess at one.
Zero items is a valid, and often correct, answer.`;

export interface GenerateInput {
  repo: Repo;
  stack: Stack | null;
  docs: { path: string; text: string }[];
  openPrs: PullInfo[];
  templates: TemplateIndexEntry[];
  /** Slugs already proposed on this repo, so the model does not repeat them. */
  existingSlugs: string[];
}

export function buildPrompt(input: GenerateInput): string {
  const { repo, stack, docs, openPrs, templates, existingSlugs } = input;

  const docText = docs.map((d) => `--- ${d.path} ---\n${d.text}`).join('\n\n') || '(no docs found)';
  const stackText = stack
    ? [
        `engine: ${stack.engine ?? '?'}`,
        `dialect: ${stack.dialect ?? '?'}`,
        `package manager: ${stack.package_manager ?? '?'}`,
        `migrations: ${stack.migrations}`,
        `scripts: ${Object.keys(stack.scripts ?? {}).join(', ') || '(none)'}`,
        `env vars expected: ${(stack.env_session ?? []).join(', ') || '(none recorded)'}`,
      ].join('\n')
    : '(no stack metadata recorded)';
  const prText = openPrs.map((p) => `#${p.number} ${p.title}`).join('\n') || '(none open)';
  const templateText =
    templates.map((t) => `${t.key} — use when: ${t.when} (default tool ${t.tool_default}, model ${t.model_default})`)
      .join('\n') || '(no templates)';

  return `Repository "${repo.name}" (${repo.github_full_name ?? repo.name}).

WHAT THE RECORD SAYS
  stage           ${repo.stage}          (the road is: ${STAGES.join(' → ')})
  completion      ${repo.pct}%
  blocker         ${repo.blocker}
  next step       ${repo.next_step ?? '(none recorded)'}
  live URL        ${repo.live_url ?? '(none)'}${repo.live_url_ok === true ? ' — answers' : repo.live_url_ok === false ? ' — does NOT answer' : ''}
  revenue model   ${repo.revenue_model ?? 'unknown'}
  payment rail    ${repo.payment_rail ?? '(none)'}
  sell URL        ${repo.sell_url ?? '(none)'}
  notes           ${repo.notes ?? '(none)'}

STACK
${stackText}

OPEN PULL REQUESTS
${prText}

DOCS
${docText}

PROMPT TEMPLATES AVAILABLE (name the one you based an item on, in the body)
${templateText}

ALREADY PROPOSED ON THIS REPO — do not repeat these slugs
${existingSlugs.join(', ') || '(none)'}

YOUR TASK
Propose AT MOST 3 items that move this repo one stage closer to earning money.
The next stage up from "${repo.stage}" is what matters; do not propose work for
stages beyond it.

For each item:
  slug              kebab-case, <= 40 chars, unique, specific ("add-stripe-checkout",
                    not "improvements")
  title             one line, imperative
  kind              "agent" (a coding session does it) or "owner" (only Anton can)
  tool              one of: ${WORK_TOOLS.join(', ')}
  model             "sonnet" for routine or well-specified work, "opus" for
                    architecture or a hard debugging job. null for owner items.
                    Never any other value.
  stage_target      the stage this item moves the repo toward, one of: ${STAGES.join(', ')}
  estimate_minutes  owner items only: honest minutes of Anton's time
  prompt_md         the COMPLETE instructions. For an agent item: what to change,
                    which files or areas, and an "## Exit criteria" section with
                    concrete, checkable bullets (a command that passes, a page
                    that renders, a test that exists). Do not write a header, a
                    branch name or a PR title — coachme prepends those. For an
                    owner item: the numbered steps, and what to have ready first.

Reply with a single strict JSON object, no prose and no markdown fence:

{"stage_suggestion": "<stage or null>", "items": [{"slug": "...", "title": "...",
"kind": "...", "tool": "...", "model": "...", "stage_target": "...",
"estimate_minutes": null, "prompt_md": "..."}]}`;
}

/** The copy-paste line the owner hands to Claude Code or Codex (Decision D-E). */
export { oneLinerFor, promptPathFor };
