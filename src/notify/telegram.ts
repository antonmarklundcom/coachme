import { redact } from '../lib/redact.js';

/**
 * The Telegram Bot API, the slice coachme uses: send a message and long-poll for updates.
 * Same approach as aiinsights' src/lib/telegram.ts (HTML parse mode with escaping, messages
 * cut at 4000 characters, the `ok` field checked on every reply), but coachme has its own bot
 * and uses getUpdates, because a local app cannot receive a webhook (PLAN.md §8).
 */

export const MAX_MESSAGE = 4000;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;

export interface TelegramUpdate { update_id: number; message?: { chat?: { id?: number | string }; text?: string } }

export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Split text into chunks of at most `max` characters, preferring line breaks. */
export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface Telegram {
  /** Send HTML (already escaped by the caller); long text goes out as several messages. */
  send(chatId: string, html: string): Promise<void>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}

export function createTelegram(token: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Telegram {
  const call = async (method: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    let json: unknown;
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      json = await res.json();
    } catch (error) {
      // The URL carries the token, so no raw error text leaves this function unredacted.
      throw new Error(redact(`Telegram ${method} failed: ${error instanceof Error ? error.message : String(error)}`).split(token).join('[redacted]'));
    }
    const reply = json as { ok?: boolean; result?: unknown; description?: string };
    if (!reply || reply.ok !== true) throw new Error(redact(`Telegram ${method} refused: ${String(reply?.description ?? 'no ok field')}`).slice(0, 300));
    return reply.result;
  };
  return {
    async send(chatId, html) {
      for (const chunk of splitMessage(html)) await call('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true });
    },
    async getUpdates(offset, timeoutSec, signal) {
      const result = await call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, signal);
      return Array.isArray(result) ? result as TelegramUpdate[] : [];
    },
  };
}
