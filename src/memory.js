/**
 * memory.js — the coach's memory, carried on the page it publishes.
 *
 * The daily run decides one nudge and records it in `data/nudges.json`. That
 * record is what makes the anti-annoyance rules work at all: the day-3 shrink,
 * "never the same nudge three days running", the weekly cap — every one of them
 * reads history, not intent. So a run whose commit does not land does not merely
 * lose a line of JSON; it resets the coach's memory to zero and makes it repeat
 * itself forever.
 *
 * That is not hypothetical. Both live runs on 2026-08-21 selected a nudge,
 * republished the dashboard, and left `main` untouched — a Routine session is
 * not always permitted to write to the repo, and it finds that out after it has
 * already decided.
 *
 * The artifact republish, meanwhile, works every time. So the page carries the
 * history it was rendered from, in a JSON block, and the next run adopts
 * whatever the page knows that the repo does not. Git stays the state of record
 * when it can be written; the page is the fallback that always can.
 *
 * Rules, in the spirit of harvest.js:
 *  - The page is never authoritative, only additive. Merging takes the union of
 *    both histories; nothing in the repo is dropped because the page lacks it.
 *  - Merging twice is a no-op — records are identified by date, type and repos.
 */

const BLOCK = /<script[^>]+id="coach-memory"[^>]*>([\s\S]*?)<\/script>/i;

/** How much history the page carries. Enough for every window the caps use. */
export const MEMORY_LIMIT = 90;

const key = (r) => `${r.date}|${r.type}|${(r.repos ?? []).join(',')}`;

/**
 * The JSON block to embed in the rendered page. `</script>` cannot appear in
 * JSON output once `<` is escaped, so the block cannot break out of the tag.
 */
export function embedMemory(nudges = {}) {
  const history = (nudges.history ?? []).slice(-MEMORY_LIMIT);
  const json = JSON.stringify({ version: 1, history }).replace(/</g, '\\u003c');
  return `<script type="application/json" id="coach-memory">${json}</script>`;
}

/** The history a fetched page carries, or null if it carries none. */
export function readMemory(html) {
  if (!html) return null;
  const m = BLOCK.exec(html);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].replace(/\\u003c/gi, '<'));
    return Array.isArray(parsed?.history) ? parsed.history : null;
  } catch {
    // A malformed block is a page that was edited by hand or truncated in
    // transit. Silence is right: the repo's own history still stands.
    return null;
  }
}

/**
 * Fold the page's history into the repo's. Returns the records adopted, in
 * order, and mutates `nudges.history` to the union sorted by date.
 */
export function adoptMemory(nudges, remote) {
  if (!Array.isArray(remote) || remote.length === 0) return [];
  const history = nudges.history ?? (nudges.history = []);
  const seen = new Set(history.map(key));
  const adopted = [];
  for (const record of remote) {
    if (!record || typeof record.date !== 'string' || typeof record.type !== 'string') continue;
    if (seen.has(key(record))) continue;
    seen.add(key(record));
    history.push(record);
    adopted.push(record);
  }
  if (adopted.length) history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return adopted;
}
