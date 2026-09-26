import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Collector } from '../types.js';
import { loadPortfolioFile } from '../../portfolio/load.js';
import { proposeStage } from '../../rank/stage.js';
import { activeStages, type Stage } from '../../portfolio/schema.js';
import { check, type Dependencies } from './check.js';
import { parse, type DomainCheck } from './parse.js';
import type { DB } from '../../db/index.js';
export function store(db: DB, rows: DomainCheck[]) {
  const insert = db.prepare('INSERT INTO domain_checks(host,at,dns_ok,status,final_url,redirects,ms,tls_expires_at,title,has_robots,has_sitemap,has_lead_form,error_kind) VALUES (@host,@at,@dns_ok,@status,@final_url,@redirects,@ms,@tls_expires_at,@title,@has_robots,@has_sitemap,@has_lead_form,@error_kind)');
  db.transaction(() => rows.forEach(row => insert.run(row)))();
}
export function suggestStages(db: DB, rows: DomainCheck[], portfolioPath: string, now: Date) {
  if (!existsSync(portfolioPath)) return;
  const portfolio = loadPortfolioFile(portfolioPath);
  for (const project of portfolio.projects) {
    let suggestion: ReturnType<typeof proposeStage> = null, host = '';
    for (const domain of project.domains) {
      const row = rows.find(r => r.host === domain.host); if (!row || row.error_kind) continue;
      const proposed = proposeStage(project.stage,{status:row.status ?? undefined,in_yaml:true,confidence:domain.confidence,title:row.title ?? undefined},now);
      if (proposed && (!suggestion || activeStages.indexOf(proposed.stage as typeof activeStages[number]) > activeStages.indexOf(suggestion.stage as typeof activeStages[number]))) { suggestion = proposed; host = domain.host; }
    }
    db.prepare('UPDATE projects SET stage_suggestion=?,stage_evidence=? WHERE id=?').run(suggestion?.stage ?? null,JSON.stringify(suggestion ? [{host,at:now.toISOString(),reason:suggestion.evidence}] : []),project.id);
  }
}
export const domainsCollector = (intervalMin = 30, portfolioPath = resolve('portfolio.yaml'), deps: Partial<Dependencies> = {}): Collector => ({
  name:'domains',intervalMin,
  async run(ctx) {
    const hosts = new Set((ctx.db.prepare('SELECT host FROM domains').all() as {host:string}[]).map(d => d.host));
    if (existsSync(portfolioPath)) loadPortfolioFile(portfolioPath).unassigned.domains.forEach(d => hosts.add(d.host));
    const queue = [...hosts], rows: DomainCheck[] = []; let cursor = 0;
    await Promise.all(Array.from({length:Math.min(6,queue.length)},async () => { while (cursor < queue.length) { const host = queue[cursor++]; rows.push(parse(await check(host,{now:ctx.now,...deps}))); } }));
    store(ctx.db,rows); suggestStages(ctx.db,rows,portfolioPath,ctx.now());
    return rows.length;
  }
});
