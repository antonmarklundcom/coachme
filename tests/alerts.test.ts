import {it,expect,vi} from 'vitest';
import {testDb,fixture,config} from './helpers.js';
import {loadPortfolio} from '../src/portfolio/load.js';
import {syncPortfolio} from '../src/portfolio/sync.js';
import {parse,type RawCheck} from '../src/collectors/domains/parse.js';
import {store} from '../src/collectors/domains/index.js';
import {evaluate,domainState,hostingStates,transition} from '../src/alerts/index.js';
import {runCollector} from '../src/collectors/runner.js';
import {collectorRegistry} from '../src/collectors/registry.js';
const now = new Date('2026-09-26T12:00:00Z');
const raw = (JSON.parse(fixture('domains/cases.json')) as {raw:RawCheck}[])[0].raw;
it('200 then repeated 503 then 200 opens exactly one live red alert and closes it',() => {
  const db = testDb(); syncPortfolio(db,loadPortfolio(fixture('portfolio.yaml').replace('stage: building','stage: live')));
  const run = (status:number) => { store(db,[parse({...raw,host:'propia.com.py',status})]); evaluate(db,[],now); };
  run(200); expect(db.prepare('SELECT * FROM alerts').all()).toHaveLength(0);
  run(503); run(503); expect(db.prepare('SELECT severity,closed_at FROM alerts').all()).toEqual([{severity:'red',closed_at:null}]);
  run(200); expect(db.prepare('SELECT severity,closed_at FROM alerts').all()).toEqual([{severity:'red',closed_at:now.toISOString()}]);
});
it('uses amber for a building site and certificates under 14 days, but red for expired TLS',() => {
  const row = parse({...raw,status:503}); expect(domainState(row,'building',now)).toEqual({kind:'down',severity:'amber'});
  expect(domainState({...row,error_kind:'ENOTFOUND'},'live',now)).toEqual({kind:'dns_gone',severity:'red'});
  expect(domainState({...row,error_kind:'ENOTFOUND'},'building',now)?.severity).toBe('amber');
  expect(domainState(parse({...raw,tls_expires_at:'2026-10-01'}),'live',now)).toEqual({kind:'tls_expiring',severity:'amber'});
  expect(domainState(parse({...raw,tls_expires_at:'2026-09-01'}),'building',now)).toEqual({kind:'tls_expired',severity:'red'});
  expect(domainState({...row,error_kind:'PLACEHOLDER'},'live',now)).toEqual({kind:'placeholder',severity:'amber'});
  const db = testDb(); syncPortfolio(db,loadPortfolio(fixture('portfolio.yaml').replace('stage: live','stage: building'))); store(db,[parse({...raw,host:'propia.com.py',status:503})]); evaluate(db,[],now); expect(db.prepare('SELECT severity FROM alerts').all()).toEqual([{severity:'amber'}]);
});
it('handles hosting thresholds, concurrent kinds, escalation, recovery and collector staleness',() => {
  const sample = {account_id:'a',at:now.toISOString(),procs:160,threads:160,node_apps:'[]',source:'ssh' as const};
  expect(hostingStates(sample,200)).toEqual([]); expect(hostingStates({...sample,threads:161},200)).toEqual([{kind:'process_pressure',severity:'amber'}]);
  expect(hostingStates({...sample,threads:190},200)[0].severity).toBe('amber'); expect(hostingStates({...sample,threads:191},200)[0].severity).toBe('red');
  expect(hostingStates({...sample,node_apps:'[{"is_next_build":true}]'},200)).toEqual([{kind:'next_build',severity:'amber'}]);
  const db = testDb(); transition(db,'hosting:a',[{kind:'process_pressure',severity:'amber'}],now.toISOString()); transition(db,'hosting:a',[{kind:'process_pressure',severity:'red'}],now.toISOString()); expect(db.prepare('SELECT severity FROM alerts').all()).toEqual([{severity:'red'}]); transition(db,'hosting:a',[],now.toISOString());
  db.prepare('INSERT INTO collector_runs(collector,started_at,finished_at,ok,items) VALUES (?,?,?,?,0)').run('domains','2026-09-26T10:00:00Z','2026-09-26T10:00:00Z',1);
  evaluate(db,[{name:'domains',intervalMin:30}],now); evaluate(db,[{name:'domains',intervalMin:30}],now); expect(db.prepare("SELECT severity FROM alerts WHERE kind='collector_stale' AND closed_at IS NULL").all()).toEqual([{severity:'amber'}]);
  db.prepare('INSERT INTO collector_runs(collector,started_at,finished_at,ok,items) VALUES (?,?,?,?,0)').run('domains',now.toISOString(),now.toISOString(),1); evaluate(db,[{name:'domains',intervalMin:30}],now); expect(db.prepare('SELECT * FROM alerts WHERE closed_at IS NULL').all()).toHaveLength(0);
});
it('runs the optional hook only after a recorded success, keeping runner semantics on hook failure',async () => {
  const db = testDb(), ctx = {db,config,now:() => now,exec:vi.fn(),log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}, hook = vi.fn(() => { expect(db.prepare('SELECT ok FROM collector_runs ORDER BY id DESC LIMIT 1').get()).toEqual({ok:1}); });
  expect(await runCollector({name:'domains',intervalMin:30,run:async () => 2,afterSuccess:hook},ctx)).toBe(true); expect(hook).toHaveBeenCalledOnce();
  expect(await runCollector({name:'domains',intervalMin:30,run:async () => { throw new Error('offline'); },afterSuccess:hook},ctx)).toBe(false); expect(hook).toHaveBeenCalledOnce();
  expect(await runCollector({name:'domains',intervalMin:30,run:async () => 1,afterSuccess:() => { throw new Error('hook failed'); }},ctx)).toBe(true);
  const registry = collectorRegistry(config); expect(registry.map(c => c.name)).toEqual(['github','local','domains','hostinger','notes','sessions','crm']); expect(registry.find(c => c.name === 'domains')?.intervalMin).toBe(30); expect(registry.find(c => c.name === 'hostinger')?.intervalMin).toBe(10); expect(registry.filter(c => c.afterSuccess).map(c => c.name)).toEqual(['local','domains','hostinger']);
});
