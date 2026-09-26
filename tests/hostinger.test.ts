import {it,expect,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,testDb,tempDir,config} from './helpers.js';
import {parse,type Sample} from '../src/collectors/hostinger/parse.js';
import {COMMAND} from '../src/collectors/hostinger/command.js';
import {hostingerCollector} from '../src/collectors/hostinger/index.js';
import {loadPortfolio} from '../src/portfolio/load.js';
import {recommend,correlate,type Account} from '../src/hosting/recommend.js';
const now = new Date('2026-09-26T12:00:00Z');
it('parses P, T, next build, cwd and domain lines',() => {
  const result = parse(fixture('hostinger/cwd.txt'),'a',now.toISOString());
  expect(result.sample).toMatchObject({procs:172,threads:192,source:'ssh'}); expect(result.domains).toEqual(['shop.test','blog.test']);
  expect(JSON.parse(result.sample.node_apps)).toEqual([{pid:301,app_dir:'/home/user/domains/shop.test/public_html',threads:32,is_next_build:false},{pid:302,app_dir:'/home/user/domains/blog.test/public_html',threads:12,is_next_build:true}]);
});
it('falls back to args when cwd is unreadable and rejects incomplete samples',() => {
  const result = parse(fixture('hostinger/args.txt'),'a',now.toISOString()); expect(JSON.parse(result.sample.node_apps).map((a:{app_dir:string}) => a.app_dir)).toEqual(['/home/user/domains/shop.test/public_html','/home/user/domains/blog.test/public_html']); expect(() => parse('T 32','a',now.toISOString())).toThrow('missing P or T');
});
it('pins the exact read-only command and excludes forbidden tokens and file writes from command and collector',() => {
  expect(COMMAND).toBe('echo "P $(ps -u $USER --no-headers | wc -l)"; echo "T $(ps -u $USER -L --no-headers | wc -l)";\nps -u $USER -o pid=,nlwp=,args= | grep -E "[n]ode|[n]ext" ; for p in $(pgrep -u $USER node); do echo "CWD $p $(readlink /proc/$p/cwd 2>/dev/null)"; done;\nls -1 ~/domains 2>/dev/null | sed \'s/^/D /\'');
  for (const name of ['command.ts','index.ts']) {
    const source = readFileSync(new URL(`../src/collectors/hostinger/${name}`,import.meta.url),'utf8');
    for (const token of ['kill','pkill','restart','pm2','npm','rm ','mv ','systemctl','reboot']) expect(source.toLowerCase()).not.toContain(token);
  }
  // The plan explicitly discards read errors to /dev/null; there are no regular-file redirects.
  expect(COMMAND.replaceAll('2>/dev/null','')).not.toMatch(/[<>]/);
});
it('uses injected exec with fixed SSH options and append-only discovery, skips accounts without SSH',async () => {
  const db = testDb(), path = join(tempDir(),'portfolio.yaml'), original = fixture('portfolio.yaml'), exec = vi.fn(async () => fixture('hostinger/cwd.txt'));
  writeFileSync(path,original); const ctx = {db,config,exec,now:() => now,log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}};
  expect(await hostingerCollector(10,path).run(ctx)).toBe(0); expect(exec).not.toHaveBeenCalled();
  const withSsh = original.replace('label: Primary host','label: Primary host\n    ssh: { host: server.test, port: 65002, user: sampleuser, key: ~/.ssh/sample }');
  expect(withSsh).not.toBe(original); writeFileSync(path,withSsh);
  expect(await hostingerCollector(10,path).run(ctx)).toBe(1);
  const args = (exec.mock.calls[0] as unknown as [string,string[]])[1]; expect(args).toEqual(['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','-p','65002','-i',expect.stringContaining('sample'),'sampleuser@server.test',COMMAND]);
  const after = readFileSync(path,'utf8'); expect(after.slice(0,after.indexOf('unassigned:'))).toBe(withSsh.slice(0,withSsh.indexOf('unassigned:')));
  expect(loadPortfolio(after).unassigned.domains.map(d => d.host)).toContain('shop.test'); expect(loadPortfolio(after).unassigned.repos).toEqual(loadPortfolio(withSsh).unassigned.repos);
  await hostingerCollector(10,path).run(ctx); expect(readFileSync(path,'utf8')).toBe(after); expect(db.prepare('SELECT * FROM process_samples').all()).toHaveLength(2);
});
const accounts:Account[] = [{id:'a',label:'Account A',process_limit:200,has_ssh:1},{id:'b',label:'Account B',process_limit:200,has_ssh:1},{id:'c',label:'Account C',process_limit:200,has_ssh:1}];
const sample = (account_id:string,threads:number,apps:{app_dir:string;threads:number;is_next_build?:boolean}[] = []):Sample => ({account_id,at:now.toISOString(),procs:threads,threads,node_apps:JSON.stringify(apps),source:'ssh'});
it('recommends moving the highest-thread app to the measured account with most headroom at high p95',() => {
  const samples = [sample('a',180,[{app_dir:'shop',threads:90}]),sample('b',20),sample('c',60)];
  expect(recommend(accounts[0],accounts,samples,now).join(' ')).toContain('Move shop from Account A to Account B');
  expect(recommend(accounts[0],accounts,[sample('a',160,[{app_dir:'shop',threads:90}])],now).join(' ')).not.toContain('Move');
});
it('recommends staggering concurrent builds, names an app over twice its peers median, and asks for data',() => {
  expect(recommend(accounts[0],accounts,[sample('a',100,[{app_dir:'a',threads:80,is_next_build:true},{app_dir:'b',threads:10,is_next_build:true},{app_dir:'c',threads:10}])],now).join(' ')).toContain('Stagger merges and deploys');
  expect(recommend(accounts[0],accounts,[sample('a',100,[{app_dir:'heavy',threads:80},{app_dir:'b',threads:10},{app_dir:'c',threads:10}])],now).join(' ')).toContain('heavy is the heaviest app');
  expect(recommend(accounts[0],accounts,[],now).join(' ')).toContain('configure SSH or post the hPanel number');
  expect(recommend(accounts[0],accounts,[{...sample('a',190),at:'2026-09-01T00:00:00Z'}],now)).toEqual(recommend(accounts[0],accounts,[],now));
});
it('correlates pressure and 30-thread jumps only with deploys in the previous 15 minutes',() => {
  const deploys = [{repo:'shop',at:'2026-09-26T11:50:00Z',sha:'abc'}];
  expect(correlate([sample('a',170)],deploys,200)[0].label).toBe('likely from shop deploy');
  expect(correlate([{...sample('a',20),at:'2026-09-26T11:40:00Z'},sample('a',50)],deploys,200)).toHaveLength(1);
  expect(correlate([sample('a',170)],[{...deploys[0],at:'2026-09-26T11:44:59Z'}],200)).toHaveLength(0);
  expect(correlate([sample('a',170)],[{...deploys[0],at:'2026-09-26T12:01:00Z'}],200)).toHaveLength(0);
});
