import { existsSync, watchFile, unwatchFile } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/index.js';
import { log } from './lib/log.js';
import { run } from './lib/exec.js';
import { loadPortfolioFile } from './portfolio/load.js';
import { syncPortfolio } from './portfolio/sync.js';
import { githubCollector } from './collectors/github/index.js';
import { localCollector } from './collectors/local/index.js';
import { createScheduler } from './collectors/scheduler.js';
import { createApp, listen } from './web/server.js';
const config = loadConfig(), db = openDb();
migrate(db);
const portfolioPath = resolve('portfolio.yaml');
const reload = () => {
  try { if (existsSync(portfolioPath)) syncPortfolio(db,loadPortfolioFile(portfolioPath)); }
  catch (error) { log.error(String(error)); }
};
if (existsSync(portfolioPath)) syncPortfolio(db,loadPortfolioFile(portfolioPath));
else log.info('Run coach portfolio generate to create portfolio.yaml');
watchFile(portfolioPath, {interval:1000}, reload);
const collectors = [githubCollector(config.collectors.github),localCollector(config.collectors.local)];
const scheduler = createScheduler(collectors,{db,config,exec:run,now:() => new Date(),log});
const server = listen(createApp({db,config,collectors,portfolioPath}),config);
scheduler.start();
log.info(`coachme listening on http://${config.host}:${config.port}`);
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { scheduler.stop(); unwatchFile(portfolioPath); server.close(() => process.exit(0)); });
