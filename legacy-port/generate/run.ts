/**
 * generate/run.ts — one generation: repo in, proposed work items out.
 *
 * Runs inside the deep scan (same cap of 5 repos per firing) and on demand at
 * `POST /api/generate?repo=<name>`, both wired in O4. Everything it needs, the
 * scan has already fetched for its own reasons — docs, open PRs, stack metadata
 * — so generating costs one extra Sonnet call per repo and no extra GitHub
 * traffic.
 *
 * Three rules keep it from becoming a backlog generator:
 *
 *   - At most 3 items (lib/generate/sanitize.ts).
 *   - Nothing at all while this repo already has an item in flight
 *     (approved…pr_open). The desk's unit of work is "the next thing", and a
 *     repo with four approved prompts is a repo with none.
 *   - Omit rather than guess: an unusable item is dropped, and zero items is a
 *     normal outcome.
 *
 * The model's `stage_suggestion` is returned but never written. A stage raise
 * needs evidence (lib/launch/stage.ts); an opinion is not evidence, however
 * confident. The scan decides stages; this function only proposes work.
 */

import { AnthropicUnavailable, anthropicKey, askClaude } from '../anthropic';
import { oneLinerFor, type Stage, type WorkItem } from '../domain';
import { isInFlight } from '../launch/items';
import {
  createWorkItems,
  getRepoById,
  getStack,
  getWorkItems,
  type WorkItemInput,
} from '../queries';
import { fetchDocs, listPulls } from '../scan/github';
import { buildPrompt, SYSTEM, withHeader } from './prompt';
import { MAX_ITEMS, parsePlanText, sanitizePlan } from './sanitize';
import { loadTemplateIndex } from './templates';

export const OWNER = 'antonmarklundcom';

/** No API key: the caller degrades to "generate later", never fails the scan. */
export class GeneratorUnavailable extends AnthropicUnavailable {}

export interface GenerateResult {
  repo: string;
  created: WorkItem[];
  /** Set when nothing was generated on purpose; `created` is then empty. */
  skipped: string | null;
  stage_suggestion: Stage | null;
  degraded: string[];
}

export interface GenerateOptions {
  /** Test seam: the whole model round-trip, so tests never touch the network. */
  ask?: typeof askClaude;
  maxTokens?: number;
}

export async function generateForRepo(
  repoId: number,
  { ask = askClaude, maxTokens = 8000 }: GenerateOptions = {}
): Promise<GenerateResult> {
  const repo = await getRepoById(repoId);
  if (!repo) throw new Error(`repo ${repoId} does not exist`);

  const degraded: string[] = [];
  const existing = await getWorkItems(repo.id);
  const inFlight = existing.find((i) => isInFlight(i.status));
  if (inFlight) {
    return {
      repo: repo.name,
      created: [],
      skipped: `"${inFlight.slug}" is already ${inFlight.status}`,
      stage_suggestion: null,
      degraded,
    };
  }

  // A second guard the plan does not spell out, learned from running it: a repo
  // whose proposals are all still waiting for a tick does not need more of
  // them. Without this, every scan spends a Sonnet call re-proposing work the
  // owner has already seen and not approved — the exact "nagging instead of
  // working" failure v3 exists to correct.
  const waiting = existing.filter((i) => i.status === 'proposed');
  if (waiting.length >= MAX_ITEMS) {
    return {
      repo: repo.name,
      created: [],
      skipped: `${waiting.length} proposals are already waiting for a tick`,
      stage_suggestion: null,
      degraded,
    };
  }

  if (!anthropicKey()) throw new GeneratorUnavailable('ANTHROPIC_API_KEY is not set');

  const fullName = repo.github_full_name ?? `${OWNER}/${repo.name}`;
  const [docs, pulls, stack] = await Promise.all([
    fetchDocs(fullName).catch((err: Error) => {
      degraded.push(`${repo.name}: docs unreadable (${err.message})`);
      return [] as { path: string; text: string }[];
    }),
    listPulls(fullName).catch((err: Error) => {
      degraded.push(`${repo.name}: pull requests unreadable (${err.message})`);
      return { open: [], mergedLast30d: [] };
    }),
    getStack(repo.id),
  ]);

  const templates = loadTemplateIndex();
  if (templates.length === 0) degraded.push('prompt template index is empty or unreadable');

  const text = await ask({
    system: SYSTEM,
    prompt: buildPrompt({
      repo,
      stack,
      docs,
      openPrs: pulls.open,
      templates,
      existingSlugs: existing.map((i) => i.slug),
    }),
    maxTokens,
    timeoutMs: 120_000,
  });

  const plan = sanitizePlan(parsePlanText(text), { exclude: existing.map((i) => i.slug) });

  const inputs: WorkItemInput[] = plan.items.map((item) => ({
    slug: item.slug,
    title: item.title,
    kind: item.kind,
    tool: item.tool,
    model: item.model,
    stage_target: item.stage_target,
    estimate_minutes: item.estimate_minutes,
    // An owner step is never pasted into an agent, so it does not get an agent's
    // one-liner; it gets the line Anton reads on his phone.
    one_liner:
      item.kind === 'owner'
        ? `Owner step${item.estimate_minutes ? ` (~${item.estimate_minutes} min)` : ''}: ${item.title}`
        : oneLinerFor(item.slug),
    // The header is prepended here, not asked for: a prompt body whose branch
    // name came from a model is a prompt nothing can track (Decision D-E/D-G).
    prompt_md: withHeader(item.prompt_md, {
      slug: item.slug,
      title: item.title,
      kind: item.kind,
      tool: item.tool,
      model: item.model,
      stage_target: item.stage_target,
      repoFullName: fullName,
      estimate_minutes: item.estimate_minutes,
    }),
  }));

  const created = await createWorkItems(repo.id, inputs, 'generator');

  return {
    repo: repo.name,
    created,
    skipped:
      created.length > 0
        ? null
        : plan.items.length > 0
          ? 'every proposal duplicated an item this repo already has'
          : 'the generator proposed nothing it could stand behind',
    stage_suggestion: plan.stage_suggestion,
    degraded,
  };
}
