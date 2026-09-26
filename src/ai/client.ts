import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import { redact } from '../lib/redact.js';
import type { Logger } from '../lib/log.js';

/**
 * The only path to the Claude API. Every call is cached by (purpose, model, input), priced
 * from the response's usage, and refused once today's spend reaches the configured cap.
 * Callers always have a deterministic fallback for a null result.
 */
export interface AiConfig {
  model: string;
  daily_usd_cap: number;
  prices: Record<string, { input: number; output: number }>; // USD per million tokens
}
export const DEFAULT_PRICES: AiConfig['prices'] = { 'claude-sonnet-5': { input: 2, output: 10 } };

/** The slice of the SDK this module uses, so tests can inject a fake. */
export interface MessagesLike {
  parse(params: Record<string, unknown>): Promise<{ parsed_output: unknown; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number } }>;
}

export interface AiDeps { db: DB; config: AiConfig; timeZone: string; now: () => Date; log?: Logger; client?: MessagesLike | null }
export type AiStatus = { state: 'off' | 'capped' | 'on'; spentToday: number; cap: number };

let shared: MessagesLike | null | undefined;
/** The real client, only when ANTHROPIC_API_KEY is set (loaded from .env.local). */
export function defaultClient(): MessagesLike | null {
  if (shared !== undefined) return shared;
  const key = process.env.ANTHROPIC_API_KEY;
  shared = key ? (new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 }).messages as unknown as MessagesLike) : null;
  return shared;
}

/** Start of today in the owner's timezone, as an ISO instant. */
export function startOfDay(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const sinceMidnight = ((+parts.hour * 60 + +parts.minute) * 60 + +parts.second) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnight).toISOString();
}

export function spentToday(deps: Pick<AiDeps, 'db' | 'timeZone' | 'now'>): number {
  return (deps.db.prepare('SELECT COALESCE(SUM(usd),0) AS usd FROM ai_calls WHERE at >= ?').get(startOfDay(deps.now(), deps.timeZone)) as { usd: number }).usd;
}

export function aiStatus(deps: AiDeps): AiStatus {
  const client = deps.client === undefined ? defaultClient() : deps.client;
  const spent = spentToday(deps);
  return { state: !client ? 'off' : spent >= deps.config.daily_usd_cap ? 'capped' : 'on', spentToday: spent, cap: deps.config.daily_usd_cap };
}

export const cost = (config: AiConfig, model: string, input: number, output: number) => {
  const p = config.prices[model] ?? DEFAULT_PRICES[model];
  if (!p) return (input * 5 + output * 25) / 1e6; // unknown model: price pessimistically so the cap still bites
  return (input * p.input + output * p.output) / 1e6;
};

export interface AskOptions<T> { purpose: string; system: string; input: unknown; schema: z.ZodType<T>; maxTokens: number }

export async function ask<T>(deps: AiDeps, opts: AskOptions<T>): Promise<T | null> {
  const model = deps.config.model;
  const payload = JSON.stringify(opts.input);
  const key = createHash('sha256').update(`${opts.purpose}\u0000${model}\u0000${opts.system}\u0000${payload}`).digest('hex');
  const hit = deps.db.prepare('SELECT output FROM ai_cache WHERE cache_key=?').get(key) as { output: string } | undefined;
  if (hit) { const cached = opts.schema.safeParse(JSON.parse(hit.output)); if (cached.success) return cached.data; }
  const client = deps.client === undefined ? defaultClient() : deps.client;
  if (!client || spentToday(deps) >= deps.config.daily_usd_cap) return null;
  try {
    const res = await client.parse({
      model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: payload }],
      output_config: { format: zodOutputFormat(opts.schema), effort: 'low' },
    });
    const at = deps.now().toISOString(), usd = cost(deps.config, model, res.usage.input_tokens, res.usage.output_tokens);
    deps.db.prepare('INSERT INTO ai_calls(at,purpose,model,cache_key,in_tok,out_tok,usd) VALUES (?,?,?,?,?,?,?)').run(at, opts.purpose, model, key, res.usage.input_tokens, res.usage.output_tokens, usd);
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens' || res.parsed_output == null) return null;
    const parsed = opts.schema.safeParse(res.parsed_output);
    if (!parsed.success) return null;
    deps.db.prepare('INSERT OR REPLACE INTO ai_cache(cache_key,output,at) VALUES (?,?,?)').run(key, JSON.stringify(parsed.data), at);
    return parsed.data;
  } catch (error) {
    const kind = error instanceof Anthropic.AuthenticationError ? 'authentication failed (check ANTHROPIC_API_KEY)'
      : error instanceof Anthropic.RateLimitError ? 'rate limited'
      : error instanceof Anthropic.APIError ? `API error ${error.status ?? ''}` : 'request failed';
    deps.log?.warn(redact(`AI ${opts.purpose}: ${kind}`));
    return null;
  }
}
