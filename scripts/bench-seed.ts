import { openDb } from '../src/db/index.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import type { Portfolio } from '../src/portfolio/schema.js';

/** A database shaped like a month of real use: 60 projects, 120 repos, 30 days of 30-minute snapshots. */
export function seed(db: ReturnType<typeof openDb>, now: Date) {
  const stages = ['idea', 'planned', 'building', 'deployed', 'live', 'earning'] as const;
  const p: Portfolio = { version: 1, owner_tz: 'America/Asuncion', limits: { hostinger_process_limit: 200 }, hosting_accounts: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    projects: Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, stage: stages[i % 6], market: 'PY' as const, kind: 'leadgen' as const, money: { model: 'leads', weight: 1 + (i % 5) },
      repos: [`r${i}`, `r${i}b`], domains: [{ host: `site${i}.com.py`, hosting: i % 2 ? 'a' : 'b' }], notes: '' })),
    unassigned: { repos: [], domains: [] } };
  syncPortfolio(db, p);
  const ins = (sql: string) => db.prepare(sql);
  const gh = ins("INSERT INTO gh_snapshots(repo,at,last_push_at,last_commit_at,open_prs,default_ci,stale_branches) VALUES (?,?,?,?,'[]','green','[]')");
  const dc = ins('INSERT INTO domain_checks(host,at,dns_ok,status,ms,title) VALUES (?,?,1,200,120,?)');
  const ps = ins("INSERT INTO process_samples(account_id,at,procs,threads,node_apps,source) VALUES (?,?,?,?,'[]','ssh')");
  db.transaction(() => {
    for (let t = 0; t < 30 * 48; t++) {
      const at = new Date(now.getTime() - t * 30 * 60_000).toISOString();
      for (let i = 0; i < 60; i++) { gh.run(`r${i}`, at, at, at); gh.run(`r${i}b`, at, at, at); dc.run(`site${i}.com.py`, at, `Site ${i}`); }
      for (const a of ['a', 'b']) for (let k = 0; k < 3; k++) ps.run(a, new Date(Date.parse(at) - k * 10 * 60_000).toISOString(), 120, 150);
    }
    const task = ins("INSERT INTO tasks(project_id,title,source_kind,status,created_at) VALUES (?,?,?,'open',?)");
    for (let i = 0; i < 600; i++) task.run(`p${i % 60}`, `Task ${i}`, ['known-issue', 'handoff', 'todo', 'session'][i % 4], now.toISOString());
    const sess = ins("INSERT INTO agent_sessions(id,tool,repo,project_id,last_at) VALUES (?,'claude',?,?,?)");
    for (let i = 0; i < 400; i++) sess.run(`s${i}`, `r${i % 60}`, `p${i % 60}`, now.toISOString());
    for (const c of ['github', 'local', 'domains', 'hostinger', 'notes', 'sessions', 'crm', 'gsc']) for (let k = 0; k < 500; k++) ins('INSERT INTO collector_runs(collector,started_at,finished_at,ok,items) VALUES (?,?,?,1,1)').run(c, now.toISOString(), now.toISOString());
  })();
}

