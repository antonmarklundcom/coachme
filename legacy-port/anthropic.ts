/**
 * anthropic.ts — the one place this app talks to the Anthropic Messages API.
 *
 * Extracted from lib/scan/classify.ts in phase O2, when the chat endpoint became
 * the second caller. Raw `fetch` rather than the SDK, deliberately: O1 set that
 * pattern, both call sites want one plain text-in/text-out request with a hard
 * timeout, and a serverless function is a place to have one fewer dependency.
 * Mixing a `fetch` call site and an SDK call site would be worse than either.
 *
 * Model policy for this whole codebase: **Sonnet or Opus, never Fable.** The
 * scan and the chat panel both read against a fixed rubric — Sonnet's job. This
 * is plan.md §4.8 and the `fable-cost-guardrail` skill, and it is not a tuning
 * knob.
 */

/** The model both the scan and the chat panel use (plan.md §5 O1/O2). */
export const COACH_MODEL = 'claude-sonnet-5';

export function anthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

/** Thrown when no API key is configured — callers degrade rather than fail. */
export class AnthropicUnavailable extends Error {}

export interface MessagesRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One non-streaming Messages request, returning the concatenated text.
 *
 * No `tools` are ever declared here, by either caller. That is not an omission:
 * it is what makes the chat endpoint structurally unable to act on the app's
 * behalf, however it is prompted (plan.md §5 O2, "read-only").
 */
export async function askClaude({
  system,
  prompt,
  maxTokens = 1024,
  timeoutMs = 45_000,
}: MessagesRequest): Promise<string> {
  const key = anthropicKey();
  if (!key) throw new AnthropicUnavailable('ANTHROPIC_API_KEY is not set');

  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: COACH_MODEL,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (body.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}
