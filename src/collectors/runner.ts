import type { Collector, CollectorContext } from './types.js';
import { redact } from '../lib/redact.js';
export type AfterSuccess = (ctx: CollectorContext) => void | Promise<void>;
export async function runCollector(collector: Collector & { afterSuccess?: AfterSuccess }, ctx: CollectorContext): Promise<boolean> {
  const started = ctx.now().toISOString();
  let ok = 1, error: string | null = null, items = 0;
  try {
    if ((process.env.COACH_FAIL ?? '').split(/[\s,]+/).includes(collector.name)) throw new Error(`Forced failure: ${collector.name}`);
    items = await collector.run(ctx);
  } catch (err) {
    ok = 0; error = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
    ctx.log.error(`${collector.name}: ${error}`);
  }
  ctx.db.prepare('INSERT INTO collector_runs(collector,started_at,finished_at,ok,error_short,items) VALUES (?,?,?,?,?,?)').run(collector.name, started, ctx.now().toISOString(), ok, error, items);
  if (ok && collector.afterSuccess) {
    try { await collector.afterSuccess(ctx); }
    catch (err) { ctx.log.error(redact(`After ${collector.name}: ${err instanceof Error ? err.message : String(err)}`).slice(0,500)); }
  }
  return !!ok;
}
