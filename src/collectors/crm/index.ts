import type { DB } from '../../db/index.js';
import type { Collector } from '../types.js';
import { countLeadsFromCsv, countLeadsFromStats, type LeadCount } from './parse.js';
import { cleanTitle, taskHash } from '../../tasks/store.js';
import { redact } from '../../lib/redact.js';

const WINDOW_DAYS = 60;
export const DEFAULT_CRM_URL = 'https://crm.clientes.com.py';
export const SPEC_PATH = 'docs/specs/vendercrm-stats-endpoint.md';

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CrmSettings { baseUrl: string; statsKey: string | null; feeds: { label: string; token: string }[] }

/** Reads VENDERCRM_* from the environment (.env.local). Values are never logged. */
export function crmSettings(env: NodeJS.ProcessEnv = process.env): CrmSettings {
  const feeds = (env.VENDERCRM_FEED_TOKENS ?? '').split(',').map(s => s.trim()).filter(Boolean).map((pair, i) => {
    const at = pair.indexOf('=');
    return at > 0 ? { label: pair.slice(0, at).trim(), token: pair.slice(at + 1).trim() } : { label: `feed${i + 1}`, token: pair };
  }).filter(f => f.token);
  return { baseUrl: (env.VENDERCRM_BASE_URL || DEFAULT_CRM_URL).replace(/\/+$/, ''), statsKey: env.VENDERCRM_STATS_KEY?.trim() || null, feeds };
}

/** Until the stats endpoint exists, keep one task in the vendercrm project pointing at the spec. */
export function ensureSpecTask(db: DB, now: Date) {
  const project = db.prepare("SELECT id FROM projects WHERE id='vendercrm'").get() as { id: string } | undefined;
  const hash = taskHash('coachme', 'vendercrm-stats-endpoint');
  if (!project || db.prepare('SELECT 1 FROM tasks WHERE source_hash=?').get(hash)) return false;
  const repo = db.prepare("SELECT name FROM repos WHERE project_id='vendercrm' ORDER BY name LIMIT 1").get() as { name: string } | undefined;
  const local = repo ? db.prepare('SELECT path FROM latest_local_snapshot WHERE repo=? LIMIT 1').get(repo.name) as { path: string } | undefined : undefined;
  const at = now.toISOString();
  db.prepare(`INSERT INTO tasks(project_id,title,source_kind,source_file,source_hash,status,closeness,effort_h,created_at,repo,local_path,detail,updated_at)
    VALUES ('vendercrm',?,'manual',?,?,'open',0.6,2,?,?,?,?,?)`).run(
    cleanTitle('Add a read-only lead stats endpoint for coachme: GET /api/ops/v1/stats/leads'), `coachme/${SPEC_PATH}`, hash, at, repo?.name ?? null, local?.path ?? null,
    cleanTitle(`Spec: C:\\Claude 1\\coachme\\${SPEC_PATH.replace(/\//g, '\\')}. Counts only (site_slug, day, count), key-authenticated, no personal data.`, 300), at);
  return true;
}

export function storeLeads(db: DB, counts: LeadCount[], since: string, source: 'stats' | 'feed') {
  const merged = new Map<string, number>();
  for (const c of counts) merged.set(`${c.source}\u0000${c.day}`, (merged.get(`${c.source}\u0000${c.day}`) ?? 0) + c.leads);
  db.transaction(() => {
    db.prepare('DELETE FROM crm_leads_daily WHERE day >= ?').run(since);
    const insert = db.prepare('INSERT INTO crm_leads_daily(crm_site,day,leads,source) VALUES (?,?,?,?)');
    for (const [k, n] of merged) { const [site, day] = k.split('\u0000'); insert.run(site, day, n, source); }
  })();
  return merged.size;
}

export function crmCollector(intervalMin = 60, settings: () => CrmSettings = crmSettings, fetchImpl: Fetch = fetch as unknown as Fetch): Collector {
  return {
    name: 'crm', intervalMin,
    async run(ctx) {
      const s = settings(), now = ctx.now();
      if (!s.statsKey) ensureSpecTask(ctx.db, now);
      const since = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.owner_tz }).format(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
      const get = async (url: string, headers: Record<string, string> = {}) => {
        const res = await fetchImpl(url, { headers: { 'User-Agent': 'coachme/4 (read-only)', ...headers }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`VenderCRM answered HTTP ${res.status}`);
        return res.text();
      };
      if (s.statsKey) {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.owner_tz }).format(now);
        const json = JSON.parse(await get(`${s.baseUrl}/api/ops/v1/stats/leads?from=${since}&to=${today}`, { Authorization: `Bearer ${s.statsKey}` }));
        return storeLeads(ctx.db, countLeadsFromStats(json), since, 'stats');
      }
      if (!s.feeds.length) { ctx.log.info('crm: no VenderCRM stats key or feed token configured; leads show as no data'); return 0; }
      const counts: LeadCount[] = [];
      for (const feed of s.feeds) {
        try { counts.push(...countLeadsFromCsv(await get(`${s.baseUrl}/api/exports/contacts?token=${encodeURIComponent(feed.token)}`), ctx.config.owner_tz, since)); }
        catch (error) { throw new Error(redact(`feed ${feed.label}: ${error instanceof Error ? error.message : String(error)}`).split(feed.token).join('[REDACTED]')); }
      }
      return storeLeads(ctx.db, counts, since, 'feed');
    },
  };
}
