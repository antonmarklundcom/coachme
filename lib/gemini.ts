/**
 * gemini.ts — the chat panel's model call, via the Gemini API.
 *
 * Anton chose Gemini Flash for the chat panel over Sonnet on cost: this endpoint
 * is asked a lot (every "Ask about X" click) and each question is a small,
 * grounded, single-repo lookup — not the kind of judgment call the scan
 * classifier makes (lib/scan/classify.ts stays on Sonnet, via lib/anthropic.ts,
 * for exactly that reason). Same read-only contract either way: no `tools`
 * declared, so the model has no mechanism to act — see lib/chat.ts's three
 * independent reasons this stays advice-only regardless of which model answers.
 *
 * Model is a `-latest` alias by default so it tracks Google's current flash
 * release without a code change; pin GEMINI_MODEL to an exact version
 * (gemini-3.7-flash, ...) if you want that instead.
 */

const DEFAULT_MODEL = 'gemini-flash-latest';

export function geminiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? null;
}

function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}

/** Thrown when no API key is configured — callers degrade rather than fail. */
export class GeminiUnavailable extends Error {}

export interface MessagesRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One non-streaming generateContent request, returning the concatenated text.
 * Same shape as lib/anthropic.ts's askClaude so callers can be model-agnostic.
 */
export async function askGemini({
  system,
  prompt,
  maxTokens = 1024,
  timeoutMs = 45_000,
}: MessagesRequest): Promise<string> {
  const key = geminiKey();
  if (!key) throw new GeminiUnavailable('GEMINI_API_KEY is not set');

  const base = process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com';
  const res = await fetch(`${base}/v1beta/models/${geminiModel()}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify({
      ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (body.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}
