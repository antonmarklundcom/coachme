import { it,expect,vi } from 'vitest';
import { fixture,testDb,config,tempDir } from './helpers.js';
import { parse,classify,errorKinds,leadForm,placeholder,type RawCheck } from '../src/collectors/domains/parse.js';
import { check,USER_AGENT } from '../src/collectors/domains/check.js';
import { domainsCollector,store,suggestStages } from '../src/collectors/domains/index.js';
import { explain,errorExplanations } from '../src/lib/explain.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
const now = new Date('2026-09-26T12:00:00Z');
const cases = JSON.parse(fixture('domains/cases.json')) as {name:string;raw:RawCheck;error:string|null;lead:number}[];
for (const entry of cases) it(`classifies fixture ${entry.name}`,() => { const result = parse(entry.raw); expect(result.error_kind).toBe(entry.error); expect(result.has_lead_form).toBe(entry.lead); expect(result.status).toBe(entry.raw.status ?? null); expect(result.redirects).toBe(entry.raw.redirects); });
it('detects the required lead fields and CRM endpoints without mistaking unrelated inputs',() => {
  for (const input of ['type="tel"','type=email','name="whatsapp"',"name='telefono'",'name=phone','name=email']) expect(leadForm(`<form><input ${input}></form>`)).toBe(true);
  for (const html of ['<script src="https://vendercrm.com/widget.js"></script>','<form action="https://clientes.com.py/leads"></form>',`<script>fetch('https://clientes.com.py/leads')</script>`]) expect(leadForm(html)).toBe(true);
  for (const html of ['<form><input name="search"></form>','<input type="email">','<p>email</p>','<script src="https://clientes.com.py.evil.test/widget"></script>']) expect(leadForm(html)).toBe(false);
  for (const text of ['Hostinger default page','parked domain','coming soon','Index of /']) expect(placeholder(text)).toBe(true);
  expect(placeholder('A hosting comparison: Hostinger vs other hosts')).toBe(false);
});
it('explains every known error and status class',() => {
  for (const kind of [...errorKinds,'PLACEHOLDER']) { expect(errorExplanations[kind]).toBeTruthy(); expect(explain({error_kind:kind},now).sentence).toBeTruthy(); }
  for (const status of [0,100,200,301,400,401,403,404,500,503]) expect(explain({status},now).sentence.length).toBeGreaterThan(15);
  expect(explain({status:503},now).sentence).toContain('process limit'); expect(explain({status:200},now).severity).toBe('ok');
  expect(explain({status:200,tls_expires_at:'2026-10-01'},now).severity).toBe('amber'); expect(explain({status:200,tls_expires_at:'2026-09-01'},now).severity).toBe('red');
  expect(explain({error_kind:'FUTURE_ERROR'},now).severity).toBe('red'); expect(explain({},now).severity).toBe('amber');
  for (const code of errorKinds) expect(classify({code})).toBe(code);
  expect(classify({cause:{code:'ENOTFOUND'}})).toBe('ENOTFOUND'); expect(classify({code:'DEPTH_ZERO_SELF_SIGNED_CERT'})).toBe('SELF_SIGNED_CERT'); expect(classify({name:'TimeoutError'})).toBe('ETIMEDOUT'); expect(classify({code:'ERR_SSL_PROTOCOL_ERROR'})).toBe('TLS_ERROR');
});
it('follows a 301 chain manually and requests metadata with the health user agent',async () => {
  const fetcher = vi.fn(async (url:string|URL|Request,options?:RequestInit) => {
    expect(options?.redirect).toBe('manual'); expect(options?.headers).toEqual({'User-Agent':USER_AGENT}); expect(options?.signal).toBeDefined();
    const path = String(url);
    if (path === 'https://site.test/') return new Response('',{status:301,headers:{location:'/first'}});
    if (path.endsWith('/first')) return new Response('',{status:302,headers:{location:'https://www.site.test/shop'}});
    if (path.endsWith('robots.txt')) return new Response('',{status:200});
    if (path.endsWith('sitemap.xml')) return new Response('',{status:404});
    return new Response('<title>A shop</title>',{status:200,headers:{'content-type':'text/html'}});
  });
  const result = parse(await check('site.test',{dns:vi.fn(async () => ({})),fetch:fetcher,tls:async () => '2027-01-01T00:00:00Z',now:() => now}));
  expect(result).toMatchObject({status:200,redirects:2,final_url:'https://www.site.test/shop',title:'A shop',has_robots:1,has_sitemap:0}); expect(fetcher).toHaveBeenCalledTimes(5);
});
it('caps redirect hops and HTML bytes, and classifies injected DNS, fetch and TLS failures',async () => {
  const deps = {dns:async () => ({}),tls:async () => undefined,now:() => now};
  let pages = 0;
  const loop = await check('site.test',{...deps,fetch:async url => { if (!String(url).endsWith('.txt') && !String(url).endsWith('.xml')) pages++; return new Response('',{status:301,headers:{location:'/loop'}}); }});
  expect(loop.error_kind).toBe('TOO_MANY_REDIRECTS'); expect(loop.redirects).toBe(5); expect(pages).toBe(6);
  const big = await check('site.test',{...deps,fetch:async () => new Response('x'.repeat(205000)+'<form><input type=email></form>',{headers:{'content-type':'text/html'}})}); expect(Buffer.byteLength(big.html!)).toBe(200*1024); expect(parse(big).has_lead_form).toBe(0);
  const unused = vi.fn(async () => new Response(''));
  expect((await check('site.test',{...deps,dns:async () => { throw {code:'ENOTFOUND'}; },fetch:unused})).error_kind).toBe('ENOTFOUND'); expect(unused).not.toHaveBeenCalled();
  expect((await check('site.test',{...deps,fetch:async () => { throw {cause:{code:'ECONNREFUSED'}}; }})).error_kind).toBe('ECONNREFUSED');
  expect((await check('site.test',{...deps,fetch:async () => new Response(''),tls:async () => { throw {code:'CERT_HAS_EXPIRED'}; }})).error_kind).toBe('CERT_HAS_EXPIRED');
  expect((await check('site.test',{...deps,fetch:async () => { throw {name:'TimeoutError'}; }})).error_kind).toBe('ETIMEDOUT');
  const unavailable = parse(await check('site.test',{...deps,fetch:async () => { throw {cause:{code:'EACCES'}}; }})); expect(unavailable.error_kind).toBe('EACCES'); expect(explain(unavailable,now).severity).toBe('amber');
  const failedPage = parse(await check('site.test',{...deps,fetch:async () => new Response('<title>Service unavailable</title>',{status:503,headers:{'content-type':'text/html'}})})); expect(failedPage.title).toBe('Service unavailable'); expect(failedPage.error_kind).toBe('HTTP_5XX');
});
it('checks all DB and unassigned domains with at most six concurrent DNS checks and stores rows',async () => {
  const db = testDb(), p = loadPortfolio(fixture('portfolio.yaml')), path = join(tempDir(),'portfolio.yaml');
  writeFileSync(path,fixture('portfolio.yaml')); syncPortfolio(db,p);
  for (let i=0;i<12;i++) db.prepare('INSERT INTO domains(host) VALUES (?)').run(`site${i}.test`);
  let active = 0, peak = 0;
  const collector = domainsCollector(30,path,{dns:async () => { active++; peak = Math.max(peak,active); await Promise.resolve(); active--; },fetch:async () => new Response('<title>Real shop</title>'),tls:async () => undefined});
  const count = await collector.run({db,config,now:() => now,exec:vi.fn(),log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
  expect(peak).toBe(6); expect(count).toBe((db.prepare('SELECT count(*) AS n FROM domains').get() as {n:number}).n); expect((db.prepare('SELECT count(*) AS n FROM domain_checks').get() as {n:number}).n).toBe(count);
  expect(readFileSync(path,'utf8')).toBe(fixture('portfolio.yaml'));
});
it('suggestions never lower stages, exclude placeholders and never write yaml',() => {
  const db = testDb(), path = join(tempDir(),'portfolio.yaml'), original = fixture('portfolio.yaml').replace('stage: building','stage: live'); writeFileSync(path,original); syncPortfolio(db,loadPortfolio(original));
  const row = parse({...cases[0].raw,host:'propia.com.py'}); store(db,[row]); suggestStages(db,[row],path,now);
  expect(db.prepare("SELECT stage_suggestion FROM projects WHERE id='propia'").get()).toEqual({stage_suggestion:null});
  const building = original.replace('stage: live','stage: building').replace('crm_site: propia','crm_site: propia, confidence: high'); writeFileSync(path,building); syncPortfolio(db,loadPortfolio(building));
  suggestStages(db,[row],path,now); expect(db.prepare("SELECT stage_suggestion FROM projects WHERE id='propia'").get()).toEqual({stage_suggestion:'live'});
  suggestStages(db,[{...row,error_kind:'PLACEHOLDER'}],path,now); expect(db.prepare("SELECT stage_suggestion FROM projects WHERE id='propia'").get()).toEqual({stage_suggestion:null}); expect(readFileSync(path,'utf8')).toBe(building);
});
