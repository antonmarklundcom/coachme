import { resolve } from 'node:path';
import type { Config } from '../config.js';
import type { Collector } from './types.js';
import { runCollector, type AfterSuccess } from './runner.js';
import { githubCollector } from './github/index.js';
import { localCollector } from './local/index.js';
import { domainsCollector } from './domains/index.js';
import { hostingerCollector } from './hostinger/index.js';
import { evaluate } from '../alerts/index.js';
import { notesCollector } from './notes/index.js';
import { sessionsCollector } from './sessions/index.js';
export function collectorRegistry(config:Config,root = process.cwd()) {
  const portfolioPath = resolve(root,'portfolio.yaml');
  const collectors: (Collector & {afterSuccess?:AfterSuccess})[] = [githubCollector(config.collectors.github),localCollector(config.collectors.local),domainsCollector(config.collectors.domains,portfolioPath),hostingerCollector(config.collectors.hostinger,portfolioPath),notesCollector(config.collectors.notes),sessionsCollector(config.collectors.sessions)];
  for (const collector of collectors) if (['domains','hostinger'].includes(collector.name)) collector.afterSuccess = ctx => evaluate(ctx.db,collectors,ctx.now());
  const notes = collectors.find(c => c.name === 'notes')!;
  collectors.find(c => c.name === 'local')!.afterSuccess = ctx => runCollector(notes, ctx).then(() => undefined);
  return collectors;
}
