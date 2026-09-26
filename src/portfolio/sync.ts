import type { DB } from '../db/index.js';
import type { Portfolio } from './schema.js';
import { redact } from '../lib/redact.js';
export function syncPortfolio(db: DB, p: Portfolio, at = new Date().toISOString()): void {
  db.transaction(() => {
    const projectIds = new Set(p.projects.map(x => x.id)), repoNames = new Set<string>(), hosts = new Set<string>();
    const accountIds = new Set(p.hosting_accounts.map(x => x.id));
    for (const a of p.hosting_accounts) db.prepare(`INSERT INTO hosting_accounts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,has_ssh=excluded.has_ssh,process_limit=excluded.process_limit`).run(a.id, redact(a.label), Number(!!a.ssh), a.process_limit ?? p.limits.hostinger_process_limit);
    const repo = (name: string, project: string | null, localPath: string | null = null) => {
      repoNames.add(name);
      db.prepare(`INSERT INTO repos(name,project_id,local_path,on_github,local_only) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET project_id=excluded.project_id,local_path=coalesce(excluded.local_path,repos.local_path),on_github=excluded.on_github,local_only=excluded.local_only`).run(name, project, localPath, Number(!localPath), Number(!!localPath));
    };
    const domain = (d: Portfolio['unassigned']['domains'][number], project: string | null) => {
      hosts.add(d.host);
      db.prepare(`INSERT INTO domains VALUES (?,?,?,?,?,?,?) ON CONFLICT(host) DO UPDATE SET project_id=excluded.project_id,hosting_account_id=excluded.hosting_account_id,app_kind=excluded.app_kind,crm_site=excluded.crm_site,source=excluded.source,confidence=excluded.confidence`).run(d.host, project, d.hosting ?? null, d.app ?? null, d.crm_site ?? null, d.source ?? null, d.confidence ?? null);
    };
    for (const project of p.projects) {
      db.prepare(`INSERT INTO projects(id,name,stage,stage_before,status_note,market,kind,money_model,money_weight,notes,paused_at,killed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,stage=excluded.stage,stage_before=excluded.stage_before,status_note=excluded.status_note,market=excluded.market,kind=excluded.kind,money_model=excluded.money_model,money_weight=excluded.money_weight,notes=excluded.notes,
        paused_at=CASE WHEN excluded.stage='paused' THEN coalesce(projects.paused_at,excluded.paused_at) ELSE NULL END,
        killed_at=CASE WHEN excluded.stage='killed' THEN coalesce(projects.killed_at,excluded.killed_at) ELSE NULL END`).run(
        project.id, redact(project.name), project.stage, project.stage_before ?? null, project.status_note ? redact(project.status_note) : null, project.market, project.kind, redact(project.money.model), project.money.weight, redact(project.notes), project.stage === 'paused' ? at : null, project.stage === 'killed' ? at : null);
      project.repos.forEach(r => repo(r, project.id)); project.domains.forEach(d => domain(d, project.id));
    }
    p.unassigned.repos.forEach(r => repo(r, null)); p.unassigned.domains.forEach(d => domain(d, null));
    p.local_only?.forEach(l => repo(`local:${l.path}`, null, l.path));
    for (const [table, key, keep] of [['repos','name',repoNames], ['domains','host',hosts], ['projects','id',projectIds], ['hosting_accounts','id',accountIds]] as const) {
      for (const row of db.prepare(`SELECT ${key} AS identity FROM ${table}`).all() as { identity: string }[]) if (!keep.has(row.identity)) db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(row.identity);
    }
  })();
}
