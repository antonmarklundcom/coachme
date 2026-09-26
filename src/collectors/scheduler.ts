import type { Collector, CollectorContext } from './types.js';
import { runCollector } from './runner.js';
export function createScheduler(collectors: Collector[], ctx: CollectorContext) {
  let running = false, stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const collector of collectors) {
        if (stopped) break;
        const row = ctx.db.prepare('SELECT MAX(finished_at) AS at FROM collector_runs WHERE collector=? AND ok=1').get(collector.name) as { at: string | null };
        if (!row.at || ctx.now().getTime() - Date.parse(row.at) >= collector.intervalMin * 60_000) await runCollector(collector, ctx);
      }
    } finally { running = false; }
  };
  return { tick, start() { if (timer) return; stopped = false; const guarded = () => { void tick().catch(e => ctx.log.error(String(e))); }; timer = setInterval(guarded, 60_000); guarded(); }, stop() { stopped = true; clearInterval(timer); timer = undefined; } };
}
