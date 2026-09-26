import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { Collector } from '../types.js';
import { loadPortfolioFile } from '../../portfolio/load.js';
import { generatePortfolio } from '../../portfolio/generate.js';
import { COMMAND } from './command.js';
import { parse } from './parse.js';
export const hostingerCollector = (intervalMin = 10, portfolioPath = resolve('portfolio.yaml')): Collector => ({
  name:'hostinger',intervalMin,
  async run(ctx) {
    if (!existsSync(portfolioPath)) return 0;
    const portfolio = loadPortfolioFile(portfolioPath); let items = 0;
    for (const account of portfolio.hosting_accounts) {
      if (!account.ssh) continue;
      const {host,port,user,key} = account.ssh;
      if (!/^[a-z0-9._-]+$/i.test(host) || host.startsWith('-') || !/^[a-z0-9._-]+$/i.test(user) || user.startsWith('-')) throw new Error('Invalid SSH account address');
      const executable = process.platform==='win32' ? join(process.env.SystemRoot ?? 'C:\\Windows','System32','OpenSSH','ssh.exe') : 'ssh';
      const output = await ctx.exec(executable,['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','-p',String(port),'-i',key.startsWith('~/') ? join(homedir(),key.slice(2)) : key,`${user}@${host}`,COMMAND],{timeout:30_000});
      const {sample,domains} = parse(output,account.id,ctx.now().toISOString());
      ctx.db.prepare('INSERT INTO process_samples(account_id,at,procs,threads,node_apps,source) VALUES (@account_id,@at,@procs,@threads,@node_apps,@source)').run(sample);
      const before = readFileSync(portfolioPath,'utf8');
      const after = generatePortfolio({repos:[],local:[],hints:[],existingYaml:before,now:sample.at,domains:domains.map(host => ({host,repo:'',source:`hostinger:${account.id}`,confidence:'high'}))}).portfolioYaml;
      if (after !== before) { writeFileSync(`${portfolioPath}.tmp`,after); renameSync(`${portfolioPath}.tmp`,portfolioPath); }
      items++;
    }
    return items;
  }
});
