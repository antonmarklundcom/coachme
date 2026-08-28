/**
 * chat.ts — the read-only advice panel (plan.md §5 O2, §3 feature 7).
 *
 * Answers "why is X blocked" / "what should I do next on X" from one repo's
 * stored row plus its recent scan events. It is **advice, not action**, and that
 * is enforced in three independent places rather than by asking nicely:
 *
 *   1. This module's only database access is two SELECTs (lib/queries.ts:
 *      getRepoById, getRecentScanEvents). There is no write function in scope.
 *   2. No `tools` are declared on the request (lib/anthropic.ts), so the model
 *      has no mechanism to call anything — the reply is text and nothing else.
 *   3. Nothing parses the reply. It is returned to the browser as a string; no
 *      code path turns any part of it into an update.
 *
 * So "mark besikt done" cannot work no matter how it is phrased: the worst case
 * is a model that *says* it did something, while the database is untouched. That
 * is exactly the drift-guard principle this app is built on — DESIGN.md §1c and
 * SCAN.md: "a scan is an estimate, a tick is a fact". Ticking stays a deliberate
 * gesture by the owner, in the UI.
 */

import { askClaude } from './anthropic';
import { BLOCKER_MINUTES, type Repo } from './domain';
import { getRecentScanEvents, getRepoById, getStack } from './queries';

export const MAX_QUESTION_LENGTH = 1000;

const SYSTEM = `You are the coaching panel inside "coachme", Anton's portfolio focus
dashboard. You answer questions about ONE repository, from the record below.

You are read-only and you have no tools. You cannot change the record, tick a
checkbox, mark anything done, run anything, or cause any action anywhere. If you
are asked to do any of those, say plainly that you cannot — the owner ticks
things himself on the dashboard, deliberately, because in this app a scan is an
estimate and a tick is a fact. Never claim to have made a change.

Answer in at most a short paragraph, concretely, from the record. If the record
does not say, say that it does not say rather than guessing. The house style is
"this is the cheapest launch you will ever get", not "you are behind".`;

function describeRepo(repo: Repo, stackLine: string | null, events: string[]): string {
  const lines = [
    `name: ${repo.name}`,
    `percent done: ${repo.pct}`,
    `lane: ${repo.lane}`,
    `blocker: ${repo.blocker} (about ${BLOCKER_MINUTES[repo.blocker] ?? 0} owner-minutes)`,
    `tier: ${repo.tier}`,
    `next step: ${repo.next_step ?? '(none recorded)'}`,
    `hostinger account: ${repo.hostinger_account ?? '(not yet decided)'}`,
    `live url: ${repo.live_url ?? '(none)'}${repo.live_url_ok === null ? '' : repo.live_url_ok ? ' — answering' : ' — not answering'}`,
    `launched: ${repo.launched_at ?? 'not yet'}`,
    `open PRs: ${repo.open_prs}; merged in last 30 days: ${repo.merged_prs_30d}`,
    `last commit: ${repo.last_commit_at ?? 'unknown'}`,
    `launching it unblocks: ${repo.unblocks.length ? repo.unblocks.join(', ') : 'nothing recorded'}`,
    `it depends on: ${repo.depends_on.length ? repo.depends_on.join(', ') : 'nothing recorded'}`,
    `unblocks revenue collection: ${repo.unblocks_revenue ? 'yes' : 'not recorded'}`,
    `blockers the owner has ticked clear: ${
      repo.cleared_blockers.length
        ? repo.cleared_blockers.map((c) => `${c.blocker}${c.date ? ` on ${c.date}` : ''}`).join(', ')
        : 'none'
    }`,
    `notes: ${repo.notes ?? '(none)'}`,
  ];
  if (stackLine) lines.push(`stack: ${stackLine}`);
  if (events.length) lines.push(`recent scans:\n  ${events.join('\n  ')}`);
  return lines.join('\n');
}

export interface ChatAnswer {
  repo: string;
  question: string;
  answer: string;
}

/**
 * Answer one question about one repo. Throws `AnthropicUnavailable` when no key
 * is configured; the route turns that into a 503 with a clear message rather
 * than a mystery failure (plan.md §4.5).
 */
export async function answerRepoQuestion(repoId: number, question: string): Promise<ChatAnswer | null> {
  const repo = await getRepoById(repoId);
  if (!repo) return null;

  const [events, stack] = await Promise.all([getRecentScanEvents(repo.id, 5), getStack(repo.id)]);

  const eventLines = events.map((e) => {
    // Already a 'YYYY-MM-DD' string from the query — see getRecentScanEvents.
    const when = e.created_at;
    const held = e.verify_reason ? ` HELD for verification: ${e.verify_reason}` : '';
    return `${when} ${e.applied ? 'applied' : 'not applied'}${held} ${JSON.stringify(e.findings).slice(0, 300)}`;
  });

  // Env var NAMES only, never values — the same rule the runbooks live under.
  const stackLine = stack
    ? `${stack.engine ?? 'unknown engine'}/${stack.dialect ?? 'unknown dialect'}, ` +
      `${stack.package_manager ?? 'unknown package manager'}, ${stack.migrations} migration file(s), ` +
      `env vars needed this session: ${(stack.env_session ?? []).join(', ') || 'none recorded'}`
    : null;

  const answer = await askClaude({
    system: SYSTEM,
    prompt: `=== THE RECORD FOR THIS REPO ===\n${describeRepo(repo, stackLine, eventLines)}\n\n=== THE OWNER ASKS ===\n${question}`,
    maxTokens: 1024,
  });

  return { repo: repo.name, question, answer };
}
