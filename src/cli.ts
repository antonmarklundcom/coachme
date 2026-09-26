#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb,migrate } from './db/index.js';
import { run } from './lib/exec.js';
import { log } from './lib/log.js';
import { generatePortfolioFiles } from './portfolio/generate.js';
import { loadPortfolioFile } from './portfolio/load.js';
import { syncPortfolio } from './portfolio/sync.js';
import { collectorRegistry } from './collectors/registry.js';
import { runCollector } from './collectors/runner.js';
import { freshness } from './collectors/freshness.js';
async function main() {
  const root = fileURLToPath(new URL('../',import.meta.url));
  const config = loadConfig(root), db = openDb(resolve(root,'data/coach.db'));
  try {
    migrate(db);
    const collectors = collectorRegistry(config,root);
    const [command,arg] = process.argv.slice(2), path = resolve(root,'portfolio.yaml');
    if (command === 'portfolio' && arg === 'generate') {
      await generatePortfolioFiles(config,run,root); syncPortfolio(db,loadPortfolioFile(path)); log.info('Portfolio generated');
    } else if (command === 'collect') {
      if (existsSync(path)) syncPortfolio(db,loadPortfolioFile(path));
      const selected = arg === 'all' ? collectors : collectors.filter(c => c.name === arg);
      if (!selected.length) throw new Error(`Choose ${collectors.map(c => c.name).join(', ')}, or all`);
      for (const collector of selected) if (!await runCollector(collector,{db,config,exec:run,now:() => new Date(),log})) process.exitCode = 1;
    } else if (command === 'status') {
      log.info('Collector | Last success | Status | Last error');
      for (const f of freshness(db,collectors)) log.info(`${f.collector} | ${f.last_ok ?? 'never'} | ${f.stale ? `stale since ${f.stale_since ?? 'never'}` : 'fresh'} | ${f.last_error ?? '-'}`);
    } else throw new Error('Usage: coach portfolio generate | coach collect NAME|all | coach status');
  } finally { db.close(); }
}
main().catch(error => { log.error(String(error)); process.exitCode = 1; });
