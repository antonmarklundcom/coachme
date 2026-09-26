import type { DB } from '../db/index.js';
import type { DomainCheck } from '../collectors/domains/parse.js';
import { explain } from '../lib/explain.js';
export function projectChecks(db:DB,id:string): (Partial<DomainCheck> & {host:string})[] {
  return db.prepare('SELECT d.host,c.at,c.dns_ok,c.status,c.final_url,c.redirects,c.ms,c.tls_expires_at,c.title,c.has_robots,c.has_sitemap,c.has_lead_form,c.error_kind FROM domains d LEFT JOIN domain_checks c ON c.id=(SELECT id FROM domain_checks WHERE host=d.host ORDER BY at DESC,id DESC LIMIT 1) WHERE d.project_id=? ORDER BY d.host').all(id) as (Partial<DomainCheck> & {host:string})[];
}
export function siteSignal(checks:Partial<DomainCheck>[],now:Date):{state:string;sentence:string} {
  if (!checks.length) return {state:'grey',sentence:'No domain assigned.'};
  const explanations = checks.map(c => explain(c,now));
  const severity = explanations.some(e => e.severity === 'red') ? 'red' : explanations.some(e => e.severity === 'amber') ? 'amber' : 'green';
  return {state:severity,sentence:checks.map((c,i) => `${c.host}: ${explanations[i].sentence}`).join(' ')};
}
export function DomainDetails({checks,now}:{checks:ReturnType<typeof projectChecks>;now:Date}) {
  const yes = (value:number|undefined) => value == null ? 'unknown' : value ? 'yes' : 'no';
  return <ul>{checks.map(c => <li><strong>{c.host}</strong>: {explain(c,now).sentence} Status {c.status ?? 'unknown'}; {c.ms ?? 'unknown'} ms; TLS days left: {c.tls_expires_at ? Math.ceil((Date.parse(c.tls_expires_at)-now.getTime())/86_400_000) : 'unknown'}; title: {c.title ?? 'none'}; robots: {yes(c.has_robots)}; sitemap: {yes(c.has_sitemap)}; lead form: {yes(c.has_lead_form)}.</li>)}</ul>;
}
