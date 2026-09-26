import { it,expect,vi } from 'vitest';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePorcelain,repoFromRemote } from '../src/collectors/local/parse.js';
import { collectLocal,localCollector } from '../src/collectors/local/index.js';
import { detectStack } from '../src/collectors/local/stack.js';
import { fixture,tempDir,testDb,config } from './helpers.js';
it('parses clean, dirty, ahead/behind, detached and no upstream',() => {
  expect(parsePorcelain(fixture('local/clean.txt'))).toEqual({branch:'main',ahead:0,behind:0,dirty_files:0});
  expect(parsePorcelain(fixture('local/dirty.txt'))).toEqual({branch:'work',ahead:3,behind:2,dirty_files:4});
  expect(parsePorcelain(fixture('local/no-upstream.txt'))).toEqual({branch:'new-work',ahead:0,behind:0,dirty_files:1});
  expect(parsePorcelain('# branch.head (detached)\n').branch).toBeNull();
});
it('matches origin URLs, never folder names',() => {
  for (const remote of ['git@github.com:antonmarklundcom/real.git','https://github.com/antonmarklundcom/real.git','ssh://git@github.com/antonmarklundcom/real.git']) expect(repoFromRemote(remote,'antonmarklundcom')).toBe('real');
  expect(repoFromRemote('git@github.com:someone/real.git','antonmarklundcom')).toBeNull();
});
it('walks one level and runs only the three fixed read commands',async () => {
  const root = tempDir();
  for (const folder of ['wrong-name','offline','nested/deeper']) mkdirSync(join(root,folder,'.git'),{recursive:true});
  const exec = vi.fn(async (cmd:string,args:string[],opts?:{cwd?:string}) => {
    expect(cmd).toBe('git');
    if (args[0] === 'remote') return opts?.cwd?.endsWith('offline') ? 'git@github.com:someone/offline.git' : 'git@github.com:antonmarklundcom/real.git';
    if (args[0] === 'status') return fixture('local/dirty.txt');
    if (args[0] === 'rev-list') return '3\n';
    throw new Error('Unexpected command');
  });
  const facts = await collectLocal([root],'antonmarklundcom',exec);
  expect(facts).toHaveLength(2); expect(facts.find(f => f.name === 'wrong-name')?.repo).toBe('real'); expect(facts.find(f => f.name === 'offline')?.local_only).toBe(true);
  expect(new Set(exec.mock.calls.map(c => JSON.stringify(c[1])))).toEqual(new Set([['remote','get-url','origin'],['status','--porcelain=v2','--branch'],['rev-list','--count','--branches','--not','--remotes']].map(x => JSON.stringify(x))));
  const db = testDb(); await localCollector().run({db,config:{...config,local_roots:[root]},exec,now:() => new Date('2026-09-26'),log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
  expect(db.prepare('SELECT count(*) AS n FROM local_snapshots WHERE local_only=1').get()).toEqual({n:1});
});
it('ports stack detection using files only and keeps only env names',() => {
  const path = tempDir(); mkdirSync(join(path,'prisma/migrations/first'),{recursive:true});
  writeFileSync(join(path,'package.json'),JSON.stringify({name:'fixture',scripts:{'db:migrate':'fixture','db:seed':'fixture'},dependencies:{prisma:'fixture'}}));
  writeFileSync(join(path,'prisma/schema.prisma'),'datasource db { provider = "mysql" }');
  writeFileSync(join(path,'.env.example'),'DATABASE_URL=\nADMIN_EMAIL=\nOTHER_NAME=\n');
  writeFileSync(join(path,'pnpm-lock.yaml'),'');
  expect(detectStack(path)).toMatchObject({engine:'prisma',dialect:'mysql',migrations:1,package_manager:'pnpm',env_session:['DATABASE_URL','ADMIN_EMAIL'],env_deferred_count:1,scripts:{migrate:'db:migrate',seed:'db:seed'}});
  const drizzle = tempDir(); writeFileSync(join(drizzle,'package.json'),JSON.stringify({dependencies:{'drizzle-orm':'fixture'},scripts:{'db:migrate':'fixture'}}));
  writeFileSync(join(drizzle,'drizzle.config.ts'),"export default {dialect: 'sqlite'}");
  expect(detectStack(drizzle)).toMatchObject({engine:'drizzle',dialect:'sqlite',migrations:0});
});
