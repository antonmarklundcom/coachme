import type { DB } from '../db/index.js';
import type { Collector } from '../collectors/types.js';
import type { DomainCheck } from '../collectors/domains/parse.js';
import type { NodeApp, Sample } from '../collectors/hostinger/parse.js';
import { explain } from '../lib/explain.js';
export interface State {kind:string;severity:'amber'|'red'}
export function domainState(check: DomainCheck, stage:string, now:Date): State | null {
  if (check.error_kind === 'CERT_HAS_EXPIRED' || check.tls_expires_at && Date.parse(check.tls_expires_at) <= now.getTime()) return {kind:'tls_expired',severity:'red'};
  if (check.error_kind === 'ENOTFOUND') return {kind:'dns_gone',severity:['live','earning'].includes(stage) ? 'red' : 'amber'};
  if (check.error_kind === 'PLACEHOLDER') return {kind:'placeholder',severity:'amber'};
  if (['EPERM','EACCES','ENETUNREACH'].includes(check.error_kind ?? '')) return {kind:'down',severity:'amber'};
  if (check.error_kind || !check.dns_ok || check.status == null || check.status < 200 || check.status >= 300) return {kind:'down',severity:['live','earning'].includes(stage) ? 'red' : 'amber'};
  if (check.tls_expires_at && Date.parse(check.tls_expires_at) - now.getTime() < 14 * 86_400_000) return {kind:'tls_expiring',severity:'amber'};
  return null;
}
export function hostingStates(sample:Sample,limit:number): State[] {
  const pressure = Math.max(sample.procs,sample.threads ?? 0) / limit;
  const states: State[] = pressure > .8 ? [{kind:'process_pressure',severity:pressure > .95 ? 'red' : 'amber'}] : [];
  if ((JSON.parse(sample.node_apps ?? '[]') as NodeApp[]).some(a => a.is_next_build)) states.push({kind:'next_build',severity:'amber'});
  return states;
}
export function transition(db:DB,subject:string,states:State[],at:string) {
  db.transaction(() => {
    const open = db.prepare('SELECT id,kind,to_state FROM alerts WHERE subject=? AND closed_at IS NULL').all(subject) as {id:number;kind:string;to_state:string}[];
    for (const alert of open) if (!states.some(s => s.kind === alert.kind)) db.prepare('UPDATE alerts SET closed_at=? WHERE id=?').run(at,alert.id);
    for (const state of states) {
      const current = open.find(a => a.kind === state.kind);
      if (current) db.prepare('UPDATE alerts SET severity=?,to_state=? WHERE id=?').run(state.severity,state.kind,current.id);
      else db.prepare('INSERT INTO alerts(kind,subject,from_state,to_state,severity,opened_at) VALUES (?,?,?,?,?,?)').run(state.kind,subject,open.map(a => a.to_state).join(',') || 'up',state.kind,state.severity,at);
    }
  })();
}
export function evaluate(db:DB,collectors:Pick<Collector,'name'|'intervalMin'>[],now:Date) {
  const at = now.toISOString();
  for (const domain of db.prepare('SELECT d.host,p.stage FROM domains d LEFT JOIN projects p ON p.id=d.project_id').all() as {host:string;stage:string}[]) {
    const check = db.prepare('SELECT * FROM domain_checks WHERE host=? ORDER BY at DESC,id DESC LIMIT 1').get(domain.host) as DomainCheck | undefined;
    if (check) { const state = domainState(check,domain.stage,now); transition(db,`domain:${domain.host}`,state ? [state] : [],at); }
  }
  for (const account of db.prepare('SELECT * FROM hosting_accounts').all() as {id:string;process_limit:number}[]) {
    const sample = db.prepare('SELECT * FROM process_samples WHERE account_id=? ORDER BY at DESC,id DESC LIMIT 1').get(account.id) as Sample | undefined;
    if (sample) transition(db,`hosting:${account.id}`,hostingStates(sample,account.process_limit),at);
  }
  for (const collector of collectors) {
    const last = db.prepare('SELECT max(finished_at) AS at FROM collector_runs WHERE collector=? AND ok=1').get(collector.name) as {at:string|null};
    const first = db.prepare('SELECT min(started_at) AS at FROM collector_runs WHERE collector=?').get(collector.name) as {at:string|null};
    const since = last.at ?? first.at;
    transition(db,`collector:${collector.name}`,since && now.getTime() - Date.parse(since) > 3 * collector.intervalMin * 60_000 ? [{kind:'collector_stale',severity:'amber'}] : [],at);
  }
}
export function alertSentence(db:DB,alert:{subject:string;kind:string},now:Date):string {
  const name = alert.subject.slice(alert.subject.indexOf(':') + 1);
  if (alert.subject.startsWith('domain:')) { const row = db.prepare('SELECT * FROM domain_checks WHERE host=? ORDER BY at DESC,id DESC LIMIT 1').get(name) as DomainCheck | undefined; if (row) return `${name}: ${explain(row,now).sentence}`; }
  const messages: Record<string,string> = {process_pressure:'Process usage is near the hosting limit; sites may stop responding.',next_build:'A Next.js build is running and using hosting capacity.',collector_stale:'No successful collection for more than three intervals; these observations may be out of date.',tls_expired:'The HTTPS certificate expired, so visitors see a warning.',tls_expiring:'The HTTPS certificate expires in under 14 days.',placeholder:'The site shows a placeholder page.',dns_gone:'The domain does not resolve.',down:'The site is not responding normally.'};
  return `${name}: ${messages[alert.kind] ?? 'This subject needs attention.'}`;
}
