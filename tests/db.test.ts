import { it,expect } from 'vitest';
import { migrate } from '../src/db/index.js';
import { readFileSync } from 'node:fs';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { fixture } from './helpers.js';
import { testDb } from './helpers.js';
it('migrates every planned table once and enables foreign keys',() => {
  const db = testDb(); migrate(db);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r => r.name);
  for (const name of ['projects','repos','domains','hosting_accounts','collector_runs','gh_snapshots','deploys','local_snapshots','agent_sessions','domain_checks','process_samples','crm_leads_daily','gsc_weekly','revenue','fx','tasks','ideas','inbox','goals','alerts','ai_calls','ai_cache','stage_changes','reviews','kv']) expect(names).toContain(name);
  expect(db.pragma('foreign_keys',{simple:true})).toBe(1); expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({n:6});
  expect(() => db.prepare("INSERT INTO gh_snapshots(repo,at,open_prs,default_ci,stale_branches) VALUES ('r','now','[]','invalid','[]')").run()).toThrow();
});
it('classification migration preserves existing rows, references and history',() => {
  const db = testDb(); syncPortfolio(db,loadPortfolio(fixture('portfolio.yaml')));
  db.prepare("UPDATE projects SET stage_suggestion='live',stage_evidence='[{\"source\":\"fixture\"}]'").run();
  const before = db.prepare('SELECT * FROM projects').all();
  db.exec(readFileSync(new URL('../migrations/002_unknown_classification.sql',import.meta.url),'utf8'));
  expect(db.prepare('SELECT * FROM projects').all()).toEqual(before);
  expect(db.prepare('SELECT DISTINCT project_id FROM repos').all()).toEqual([{project_id:'propia'}]);
  expect(db.prepare('SELECT project_id FROM domains').get()).toEqual({project_id:'propia'});
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.prepare("UPDATE projects SET market='unknown',kind='unknown'").run();
});
