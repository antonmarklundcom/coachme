import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Collector } from './types.js';
import type { AfterSuccess } from './runner.js';
import { githubCollector } from './github/index.js';
import { localCollector } from './local/index.js';
import { domainsCollector } from './domains/index.js';
import { hostingerCollector } from './hostinger/index.js';
import { evaluate } from '../alerts/index.js';
// Phase 1's config schema strips unknown keys; validate health intervals here.
export function collectorRegistry(config:Config,root = process.cwd()) {
  const health = z.object({collectors:z.object({domains:z.number().positive().default(30),hostinger:z.number().positive().default(10)})}).parse(parse(readFileSync(resolve(root,'config.yaml'),'utf8'))).collectors;
  const portfolioPath = resolve(root,'portfolio.yaml');
  const collectors: (Collector & {afterSuccess?:AfterSuccess})[] = [githubCollector(config.collectors.github),localCollector(config.collectors.local),domainsCollector(health.domains,portfolioPath),hostingerCollector(health.hostinger,portfolioPath)];
  for (const collector of collectors) if (['domains','hostinger'].includes(collector.name)) collector.afterSuccess = ctx => evaluate(ctx.db,collectors,ctx.now());
  return collectors;
}
