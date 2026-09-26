import { it,expect,vi } from 'vitest';
import { writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('@hono/node-server',() => ({serve:vi.fn(() => ({close:vi.fn()}))}));
import { serve } from '@hono/node-server';
import { createApp,listen } from '../src/web/server.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { configSchema,parseEnv } from '../src/config.js';
import { parseGitHub } from '../src/collectors/github/parse.js';
import { fixture,testDb,tempDir,config } from './helpers.js';
function setup() {
  const db = testDb(), portfolioPath = join(tempDir(),'portfolio.yaml'); writeFileSync(portfolioPath,fixture('portfolio.yaml'));
  syncPortfolio(db,loadPortfolio(fixture('portfolio.yaml')));
  const row = parseGitHub(JSON.parse(fixture('github/page.json')),new Date('2026-09-26')).snapshots[0];
  db.prepare('INSERT INTO gh_snapshots(repo,at,last_push_at,last_commit_at,open_prs,default_ci,stale_branches) VALUES (@repo,@at,@last_push_at,@last_commit_at,@open_prs,@default_ci,@stale_branches)').run(row);
  db.prepare("INSERT INTO gh_snapshots(repo,at,open_prs,default_ci,stale_branches) VALUES ('app.propia','2026-09-26','[]','none','[]')").run();
  db.prepare("INSERT INTO local_snapshots(path,at,repo,dirty_files,unpushed_commits,branch,ahead,behind,local_only) VALUES ('fixture','2026-09-26','propia.node',2,1,'main',1,0,0)").run();
  const app = createApp({db,config,portfolioPath,collectors:[{name:'github',intervalMin:30},{name:'local',intervalMin:15}],now:() => new Date('2026-09-26T12:00:00Z')});
  return {app,db,portfolioPath};
}
it('serves all pages, portfolio dots, local dirt and project details',async () => {
  const {app} = setup();
  for (const path of ['/','/portfolio','/portfolio?all=1','/project/propia','/hosting','/inbox','/ideas','/goals','/review','/health']) expect((await app.request(path)).status).toBe(200);
  const html = await (await app.request('/portfolio')).text();
  expect(html).toContain('data-project="propia"'); expect(html).toContain('CI: green'); expect(html).toContain('Activity: green'); expect(html).toContain('2 dirty files'); expect(html).toContain('stale since never');
  const detail = await (await app.request('/project/propia')).text(); expect(detail).toContain('Finish the form'); expect(detail).toContain('old-feature'); expect(detail).toContain('propia.com.py');
});
it('renders compact sorted cards, folded actions, counts and local-only work',async () => {
  const {app,db} = setup();
  const p = loadPortfolio(fixture('portfolio.yaml'));
  p.projects.push({...p.projects[0],id:'recent',name:'Recent',repos:['recent'],domains:[]}, {...p.projects[0],id:'older',name:'Older',repos:['older'],domains:[]});
  syncPortfolio(db,p);
  db.prepare("INSERT INTO gh_snapshots(repo,at,last_commit_at,open_prs,default_ci,stale_branches) VALUES ('recent','2026-09-26','2026-09-26','[]','red','[]'),('older','2026-09-26','2026-08-20','[]','none','[]')").run();
  db.prepare("INSERT INTO local_snapshots(path,at,repo,dirty_files,unpushed_commits,branch,ahead,behind,local_only) VALUES ('offline/path','2026-09-26',NULL,4,3,'work',0,0,1)").run();
  const html = await (await app.request('/portfolio')).text();
  const card = html.match(/<article class="card" data-project="propia">([\s\S]*?)<\/article>/)![1];
  expect(card).toContain('aria-label="Last activity age">1d'); expect(card).toContain('1 open PR');
  expect(card).toMatch(/<details><summary>Pause or kill<\/summary><form[\s\S]*name="reason"[\s\S]*>Pause<\/button>[\s\S]*>Kill<\/button><\/form><\/details>/);
  expect(card.split('<details>')[0]).not.toContain('<input');
  expect(html.indexOf('data-project="recent"')).toBeLessThan(html.indexOf('data-project="propia"'));
  expect(html.indexOf('data-project="propia"')).toBeLessThan(html.indexOf('data-project="older"'));
  expect(html).toContain('building <span class="stage-count">(3)');
  expect(html).toContain('>5w</span>'); expect(html).toContain('class="signal-red"'); expect(html).toContain('CI red');
  expect(html).not.toContain('class="badge"');
  expect(html).toContain('Local work not on GitHub'); expect(html).toContain('offline/path'); expect(html).toContain('Branch: work'); expect(html).toContain('4 dirty files'); expect(html).toContain('3 unpushed commits');
  expect(html).toContain('overflow-x:auto'); expect(html).toContain('@media(max-width:699px)');
  db.prepare("INSERT INTO alerts(kind,subject,severity,opened_at) VALUES ('test','fixture','red','2026-09-26')").run();
  expect(await (await app.request('/portfolio')).text()).toContain('aria-label="1 open red alerts">1</span>');
});
it('rejects missing reasons, persists pause and kill, hides cards and resumes',async () => {
  const {app,portfolioPath} = setup(), before = readFileSync(portfolioPath,'utf8');
  expect((await app.request('/project/propia/pause',{method:'POST'})).status).toBe(400); expect(readFileSync(portfolioPath,'utf8')).toBe(before);
  for (const action of ['pause','kill']) {
    expect((await app.request(`/project/propia/${action}`,{method:'POST',body:new URLSearchParams({reason:'Need to focus'})})).status).toBe(303);
    expect(readFileSync(portfolioPath,'utf8')).toContain('# Keep this comment');
    expect(await (await app.request('/portfolio')).text()).not.toContain('data-project="propia"');
    expect(await (await app.request('/portfolio?all=1')).text()).toContain('data-project="propia"');
    expect((await app.request('/project/propia/resume',{method:'POST'})).status).toBe(303);
    expect(loadPortfolio(readFileSync(portfolioPath,'utf8')).projects[0].stage).toBe('building');
  }
});
it('escapes untrusted names, notes and alerts',async () => {
  const {app,db} = setup();
  db.prepare('UPDATE projects SET name=?,notes=?').run('<script>bad()</script>','<img src=x onerror=bad()>');
  db.prepare("INSERT INTO alerts(kind,subject,severity,opened_at) VALUES ('test',?,'red','2026-09-26')").run('<script>bad()</script>');
  for (const path of ['/','/portfolio','/project/propia']) { const html = await (await app.request(path)).text(); expect(html).not.toContain('<script>bad()'); expect(html).toContain('&lt;script&gt;'); }
});
it('passes only the validated config host to listen',() => {
  const {app} = setup(); listen(app,{...config,port:4567});
  expect(serve).toHaveBeenCalledWith({fetch:app.fetch,hostname:config.host,port:4567});
  expect(() => configSchema.parse({...config,host:'0.0.0.0'})).toThrow();
  expect(() => listen(app,{...config,host:'0.0.0.0'} as typeof config)).toThrow();
});
it('parses environment values without logging them',() => {
  expect(parseEnv('# comment\nNAME="fixture value"\nBLANK=\nOTHER=plain # comment')).toEqual({NAME:'fixture value',BLANK:'',OTHER:'plain'});
});
it('accepts every upward stage suggestion from the board in one yaml write and keeps comments',async () => {
  const {app,db,portfolioPath} = setup();
  db.prepare("UPDATE projects SET stage_suggestion='live',stage_evidence='[]' WHERE id='propia'").run();
  const board = await (await app.request('/portfolio')).text();
  expect(board).toContain('Evidence suggests a new stage for 1 project');
  expect((await app.request('/portfolio/accept-stages',{method:'POST'})).status).toBe(303);
  const yaml = readFileSync(portfolioPath,'utf8');
  expect(loadPortfolio(yaml).projects.find(p => p.id === 'propia')?.stage).toBe('live');
  expect(yaml).toContain('# Keep this comment');
  expect(db.prepare("SELECT stage,stage_suggestion FROM projects WHERE id='propia'").get()).toEqual({stage:'live',stage_suggestion:null});
  expect(await (await app.request('/project/propia')).text()).toContain('Open PRs (');
});
