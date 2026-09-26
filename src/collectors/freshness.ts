import type { DB } from '../db/index.js';
import type { Collector } from './types.js';
export interface Freshness { collector: string; last_ok: string | null; last_error: string | null; stale: boolean; stale_since: string | null }
export function freshness(db: DB, collectors: Pick<Collector, 'name' | 'intervalMin'>[], now = new Date()): Freshness[] {
  return collectors.map(c => {
    const success = db.prepare('SELECT finished_at FROM collector_runs WHERE collector=? AND ok=1 ORDER BY finished_at DESC,id DESC LIMIT 1').get(c.name) as { finished_at: string } | undefined;
    const latest = db.prepare('SELECT ok,error_short FROM collector_runs WHERE collector=? ORDER BY id DESC LIMIT 1').get(c.name) as { ok: number; error_short: string | null } | undefined;
    const lastError = db.prepare('SELECT error_short FROM collector_runs WHERE collector=? AND ok=0 ORDER BY id DESC LIMIT 1').get(c.name) as { error_short: string } | undefined;
    const last = success?.finished_at ?? null;
    return { collector: c.name, last_ok: last, last_error: lastError?.error_short ?? null,
      stale: !last || latest?.ok === 0 || now.getTime() - Date.parse(last) > 3 * c.intervalMin * 60_000, stale_since: last };
  });
}
