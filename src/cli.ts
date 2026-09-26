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
import { addInbox } from './web/today.js';
import { buildToday } from './today/service.js';
import { setTaskStatus } from './tasks/store.js';
import { alertSentence } from './alerts/index.js';
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
    } else if (command === 'add') {
      const text = process.argv.slice(3).join(' ').trim();
      if (!text) throw new Error('Usage: coach add TEXT');
      addInbox(db,text,'cli',new Date()); log.info('Added to inbox.');
    } else if (command === 'today') {
      const now = () => new Date();
      const alerts = db.prepare("SELECT kind,subject,severity FROM alerts WHERE closed_at IS NULL AND severity='red'").all() as {kind:string;subject:string;severity:string}[];
      for (const a of alerts) log.info(`BROKEN  ${alertSentence(db,a,now())}`);
      const view = await buildToday({db,now,githubOwner:config.github_owner,timeZone:config.owner_tz,ai:{db,config:config.ai,timeZone:config.owner_tz,now,log}});
      if (!view.actions.length) log.info('No open tasks.');
      view.actions.forEach((a,i) => log.info(`${i + 1}. [${a.task.id}] ${a.task.title}
   ${a.project?.name ?? a.task.repo ?? 'no project'} · ${a.reason}`));
    } else if (command === 'task' && (arg === 'done' || arg === 'drop')) {
      const id = Number(process.argv[4]);
      if (!Number.isInteger(id) || !setTaskStatus(db,id,arg === 'done' ? 'done' : 'dropped',new Date())) throw new Error('Usage: coach task done|drop ID (see coach today)');
      log.info(`Task ${id} marked ${arg === 'done' ? 'done' : 'dropped'}.`);
    } else throw new Error('Usage: coach portfolio generate | coach collect NAME|all | coach status | coach add TEXT | coach today | coach task done|drop ID');
  } finally { db.close(); }
}
main().catch(error => { log.error(String(error)); process.exitCode = 1; });
