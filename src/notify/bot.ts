import type { DB } from '../db/index.js';
import type { Logger } from '../lib/log.js';
import { redact } from '../lib/redact.js';
import { addInbox } from '../web/today.js';
import { escapeHtml, type Telegram, type TelegramUpdate } from './telegram.js';
import { getKv, setKv } from './rules.js';

/**
 * Anton's side of the bot: plain text goes to the inbox, `/today` answers with the day's
 * actions, `/idea …` parks an idea. Messages from any chat other than TELEGRAM_CHAT_ID are
 * ignored without a reply and without touching the database.
 */

export interface BotDeps { db: DB; chatId: string; now: () => Date; today: () => Promise<string> }

const HELP = 'Send any text and it lands in the coachme inbox.\n/today: red alerts and your 3 things\n/idea TEXT: park an idea';

/** Handle one update; returns the HTML reply, or null when the update is ignored. */
export async function handleUpdate(deps: BotDeps, update: TelegramUpdate): Promise<string | null> {
  const message = update.message, text = message?.text?.trim();
  if (!message || String(message.chat?.id ?? '') !== deps.chatId || !text) return null;
  const command = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!command) {
    addInbox(deps.db, redact(text), 'telegram', deps.now());
    return 'In the inbox.';
  }
  const [, name, rest = ''] = command;
  if (name === 'today') return deps.today();
  if (name === 'idea') {
    const idea = redact(rest.trim()).slice(0, 2000);
    if (!idea) return 'Usage: /idea TEXT';
    deps.db.prepare("INSERT INTO ideas(text,created_at,status) VALUES (?,?,'parked')").run(idea, deps.now().toISOString());
    return 'Parked on /ideas.';
  }
  return escapeHtml(HELP);
}

const OFFSET = 'telegram_offset';

/** Long-poll getUpdates until stopped. The offset is stored so a restart does not replay handled messages. */
export function startBot(deps: BotDeps & { telegram: Telegram; log: Logger; pollSec?: number; retryMs?: number }) {
  const controller = new AbortController();
  let stopped = false;
  const wait = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); controller.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
  const loop = async () => {
    while (!stopped) {
      try {
        const offset = Number(getKv(deps.db, OFFSET) ?? 0);
        const updates = await deps.telegram.getUpdates(offset, deps.pollSec ?? 50, controller.signal);
        for (const update of updates) {
          try {
            const reply = await handleUpdate(deps, update);
            if (reply) await deps.telegram.send(deps.chatId, reply);
          } catch (error) { deps.log.warn(redact(`Telegram message: ${error instanceof Error ? error.message : String(error)}`)); }
          setKv(deps.db, OFFSET, String(update.update_id + 1), deps.now());
        }
      } catch (error) {
        if (stopped) break;
        deps.log.warn(redact(error instanceof Error ? error.message : String(error)));
        await wait(deps.retryMs ?? 30_000);
      }
    }
  };
  const done = loop();
  return { stop() { stopped = true; controller.abort(); return done; } };
}
