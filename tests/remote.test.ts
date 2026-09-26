import { it,expect,vi } from 'vitest';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatherRemoteFiles } from '../src/portfolio/remote.js';
import { generatePortfolio,generatePortfolioFiles } from '../src/portfolio/generate.js';
import { discoverDomains,readDiscoveryFiles,discoveryPaths } from '../src/portfolio/discover.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { fixture,tempDir,config } from './helpers.js';

it('feeds remote blob fixture texts into the pure generator using the shared discovery rules',async () => {
  const exec = vi.fn(async () => fixture('remote-blobs.json'));
  const repos = [{name:'propia.node',isArchived:false,pushedAt:null}];
  const discoveryInputs = await gatherRemoteFiles(exec,config.github_owner,repos);
  const output = generatePortfolio({repos,local:[],domains:[],discoveryInputs,hints:[],now:'2026-09-26'});
  expect(output.portfolio.projects[0]).toMatchObject({market:'PY',kind:'unknown'});
  expect(output.portfolio.projects[0].domains).toEqual([
    {host:'propia.com.py',source:'src/lib/site.ts site URL',confidence:'high'},
    {host:'propia-app.test',source:'config.php site URL',confidence:'high'},
    {host:'propia.se',source:'README.md matching URL',confidence:'medium'},
  ]);
  const path = tempDir();
  for (const [name,text] of Object.entries(discoveryInputs[0].files)) { const parts = name.split('/'); parts.pop(); mkdirSync(join(path,...parts),{recursive:true}); writeFileSync(join(path,name),text); }
  expect(discoverDomains({repo:repos[0].name,files:readDiscoveryFiles(path)})).toEqual(discoverDomains(discoveryInputs[0]));
});
it('makes one read-only GraphQL request per 20 repos with every required HEAD path',async () => {
  const blobs = JSON.parse(fixture('remote-blobs.json')).data.r0;
  const exec = vi.fn(async () => JSON.stringify({data:Object.fromEntries(Array.from({length:20},(_,i) => [`r${i}`,blobs]))}));
  const repos = Array.from({length:41},(_,i) => ({name:`repo-${i}`}));
  expect(await gatherRemoteFiles(exec,config.github_owner,repos)).toHaveLength(41);
  expect(exec).toHaveBeenCalledTimes(3);
  for (const call of exec.mock.calls as unknown as [string,string[]][]) {
    expect(call[0]).toBe('gh'); expect(call[1].slice(0,3)).toEqual(['api','graphql','-f']);
    for (const path of discoveryPaths) expect(call[1][3]).toContain(`HEAD:${path}`);
    expect(call[1][3]).not.toMatch(/\bmutation\b/);
  }
  expect((exec.mock.calls as unknown as [string,string[]][])[2][1][3]).not.toContain('r1: repository');
});
it('wrapper fetches remote blobs only for repos with no local checkout',async () => {
  const root = tempDir(), checkouts = join(root,'checkouts'); mkdirSync(join(checkouts,'local','.git'),{recursive:true});
  writeFileSync(join(checkouts,'local','CNAME'),'local.test');
  const exec = vi.fn(async (cmd:string,args:string[]) => {
    if (cmd === 'git') return args[0] === 'remote' ? 'git@github.com:antonmarklundcom/local.git' : args[0] === 'status' ? fixture('local/clean.txt') : '0';
    if (args[0] === 'repo') return JSON.stringify([{name:'propia.node',isArchived:false,pushedAt:null},{name:'local',isArchived:false,pushedAt:null}]);
    expect(args[3]).toContain('name:"propia.node"'); expect(args[3]).not.toContain('name:"local"');
    return fixture('remote-blobs.json');
  });
  await generatePortfolioFiles({...config,local_roots:[checkouts]},exec,root,new Date('2026-09-26'));
  const text = readFileSync(join(root,'portfolio.yaml'),'utf8');
  expect(loadPortfolio(text).projects.flatMap(p => p.domains).map(d => d.host)).toContain('propia.com.py');
  await generatePortfolioFiles({...config,local_roots:[checkouts]},exec,root,new Date('2026-09-26'));
  expect(readFileSync(join(root,'portfolio.yaml'),'utf8')).toBe(text);
});
