import {it,expect} from 'vitest';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,testDb,tempDir,config} from './helpers.js';
import {createApp} from '../src/web/server.js';
import {loadPortfolio} from '../src/portfolio/load.js';
import {syncPortfolio} from '../src/portfolio/sync.js';
import {parse,type RawCheck} from '../src/collectors/domains/parse.js';
import {store,suggestStages} from '../src/collectors/domains/index.js';
import {evaluate} from '../src/alerts/index.js';
import {siteSignal} from '../src/web/domains.js';
const now = new Date('2026-09-26T12:00:00Z');
function setup(text = fixture('portfolio.yaml').replace('stage: building','stage: live')) {
  const db = testDb(), portfolioPath = join(tempDir(),'portfolio.yaml'); writeFileSync(portfolioPath,text); syncPortfolio(db,loadPortfolio(text));
  return {db,portfolioPath,app:createApp({db,config,portfolioPath,collectors:[],now:() => now})};
}
const raw = (JSON.parse(fixture('domains/cases.json')) as {raw:RawCheck}[])[0].raw;
it('renders the SVG limit and deploy marker, and stores validated manual samples with unknown threads',async () => {
  const {db,app} = setup();
  db.prepare("INSERT INTO deploys(repo,at,sha,source) VALUES ('propia.node','2026-09-26T11:50:00Z','abc','push to default branch')").run();
  const page = await (await app.request('/hosting')).text(); expect(page).toContain('<svg'); expect(page).toContain('data-kind="limit"'); expect(page).toContain('data-kind="deploy"'); expect(page).toContain('action="/hosting/hst-a/manual"');
  const response = await app.request('/hosting/hst-a/manual',{method:'POST',body:new URLSearchParams({processes:'192'})}); expect(response.status).toBe(303);
  expect(db.prepare('SELECT procs,threads,source FROM process_samples').all()).toEqual([{procs:192,threads:null,source:'manual'}]); expect(db.prepare('SELECT severity FROM alerts').all()).toEqual([{severity:'red'}]);
  const after = await (await app.request('/hosting')).text(); expect(after).toContain('192 processes'); expect(after).toContain('likely from propia.node deploy');
  for (const value of ['','-1','1.2','NaN','1000001']) expect((await app.request('/hosting/hst-a/manual',{method:'POST',body:new URLSearchParams({processes:value})})).status).toBe(400);
  expect((await app.request('/hosting/missing/manual',{method:'POST',body:new URLSearchParams({processes:'5'})})).status).toBe(404);
});
it('renders site dots, details, plain red alerts before collapsed amber alerts and nav counts',async () => {
  const {db,app} = setup(); store(db,[parse({...raw,host:'propia.com.py',status:503})]); evaluate(db,[],now);
  db.prepare("INSERT INTO alerts(kind,subject,to_state,severity,opened_at) VALUES ('collector_stale','collector:local','collector_stale','amber',?)").run(now.toISOString());
  const today = await (await app.request('/')).text(); expect(today).toContain('Node app is down'); expect(today.indexOf('Node app is down')).toBeLessThan(today.indexOf('<details')); expect(today).toContain('<details><summary>1 amber alerts'); expect(today).toContain('1 open red alerts');
  for (const url of ['/portfolio','/project/propia','/hosting','/inbox']) expect(await (await app.request(url)).text()).toContain('1 open red alerts');
  const board = await (await app.request('/portfolio')).text(); expect(board).toContain('Site: red'); expect(board).toContain('title="propia.com.py: The Node app');
  const project = await (await app.request('/project/propia')).text(); for (const text of ['Status 503','25 ms','TLS days left','robots: yes','sitemap: yes','lead form: yes']) expect(project).toContain(text);
  expect(siteSignal([],now).state).toBe('grey'); expect(siteSignal([parse(raw)],now).state).toBe('green'); expect(siteSignal([parse(raw),{error_kind:'PLACEHOLDER'}],now).state).toBe('amber');
});
it('accepts a suggestion only through POST, preserving comments and never lowering the YAML stage',async () => {
  const text = fixture('portfolio.yaml').replace('stage: building','stage: deployed').replace('crm_site: propia','crm_site: propia, confidence: high');
  const {db,app,portfolioPath} = setup(text), row = parse({...raw,host:'propia.com.py'}); store(db,[row]); suggestStages(db,[row],portfolioPath,now);
  const page = await (await app.request('/project/propia')).text(); expect(page).toContain('Evidence says live'); expect(readFileSync(portfolioPath,'utf8')).toBe(text);
  expect((await app.request('/project/propia/accept-stage')).status).toBe(404); expect(readFileSync(portfolioPath,'utf8')).toBe(text);
  expect((await app.request('/project/propia/accept-stage',{method:'POST'})).status).toBe(303); const result = readFileSync(portfolioPath,'utf8'); expect(loadPortfolio(result).projects[0].stage).toBe('live'); expect(result).toContain("# Anton's hand-edited portfolio");
  db.prepare("UPDATE projects SET stage_suggestion='building' WHERE id='propia'").run(); expect((await app.request('/project/propia/accept-stage',{method:'POST'})).status).toBe(400); expect(readFileSync(portfolioPath,'utf8')).toBe(result);
});
