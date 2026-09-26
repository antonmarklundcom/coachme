import type { DB } from '../db/index.js';
import { crmKeys } from '../collectors/crm/parse.js';
import { proposeStage } from '../rank/stage.js';
import type { Stage } from '../portfolio/schema.js';

export const CURRENCIES = ['PYG', 'SEK', 'USD', 'EUR'] as const;
export type Currency = typeof CURRENCIES[number];
export const RECURRING = ['none', 'monthly', 'yearly'] as const;

/** Units of each currency per 1 USD. USD is always 1; the others are set by Anton on /goals. */
export function fxRates(db: DB): Record<Currency, number | null> {
  const rows = new Map((db.prepare('SELECT currency, per_usd FROM fx').all() as { currency: Currency; per_usd: number }[]).map(r => [r.currency, r.per_usd]));
  return { USD: 1, PYG: rows.get('PYG') ?? null, SEK: rows.get('SEK') ?? null, EUR: rows.get('EUR') ?? null };
}

/** Convert between currencies through USD; null when a needed rate is not set. */
export function convert(amount: number, from: Currency, to: Currency, fx: Record<Currency, number | null>): number | null {
  if (from === to) return amount;
  const a = fx[from], b = fx[to];
  return a && b ? (amount / a) * b : null;
}

export interface RevenueRow { id: number; project_id: string | null; client: string | null; amount: number; currency: Currency; recurring: 'none' | 'monthly' | 'yearly'; date: string; note: string | null }

/** Month key (YYYY-MM) of a date in the owner timezone. */
export const monthOf = (date: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(date);

export interface MoneySummary { currency: Currency; thisMonth: number; last30: number; mrr: number; missingRates: Currency[]; byProject: { project_id: string | null; total: number }[] }

/**
 * This month's revenue, the last 30 days, and monthly recurring revenue (monthly entries plus
 * yearly ÷ 12, counting each recurring client once at its latest amount), in one currency.
 */
export function moneySummary(db: DB, currency: Currency, now: Date, timeZone: string): MoneySummary {
  const fx = fxRates(db), rows = db.prepare('SELECT * FROM revenue ORDER BY date').all() as RevenueRow[];
  const missing = new Set<Currency>();
  const conv = (r: RevenueRow) => { const v = convert(r.amount, r.currency, currency, fx); if (v === null) missing.add(r.currency); return v ?? 0; };
  const month = monthOf(now, timeZone), since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  let thisMonth = 0, last30 = 0;
  const byProject = new Map<string | null, number>(), recurring = new Map<string, RevenueRow>();
  for (const r of rows) {
    const v = conv(r);
    if (r.date.slice(0, 7) === month) thisMonth += v;
    if (r.date >= since30) last30 += v;
    byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + v);
    if (r.recurring !== 'none') recurring.set(`${r.project_id}\u0000${(r.client ?? '').toLowerCase()}\u0000${r.recurring}`, r);
  }
  const mrr = [...recurring.values()].reduce((sum, r) => sum + conv(r) / (r.recurring === 'yearly' ? 12 : 1), 0);
  return { currency, thisMonth, last30, mrr, missingRates: [...missing], byProject: [...byProject].map(([project_id, total]) => ({ project_id, total })).sort((a, b) => b.total - a.total) };
}

/** Lead counts for a project over [from, to] (inclusive days), via its domains' CRM keys. */
export function projectLeads(db: DB, projectId: string, from: string, to: string): number | null {
  const domains = db.prepare('SELECT host, crm_site FROM domains WHERE project_id=?').all(projectId) as { host: string; crm_site: string | null }[];
  const keys = [...new Set(domains.flatMap(d => crmKeys(d.host, d.crm_site)))];
  if (!keys.length || !(db.prepare('SELECT 1 FROM crm_leads_daily LIMIT 1').get())) return null;
  return (db.prepare(`SELECT COALESCE(SUM(leads),0) AS n FROM crm_leads_daily WHERE day BETWEEN ? AND ? AND crm_site IN (${keys.map(() => '?').join(',')})`).get(from, to, ...keys) as { n: number }).n;
}

/** Leads dot: green when the last 7 days hold up against the 7 before, amber when falling, red when they stopped, grey without data. */
export function leadsSignal(db: DB, projectId: string, now: Date, timeZone: string): { state: string; sentence: string } {
  const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(now.getTime() - offset * 86_400_000));
  const last = projectLeads(db, projectId, day(6), day(0)), prev = projectLeads(db, projectId, day(13), day(7));
  if (last === null || prev === null) return { state: 'grey', sentence: 'No CRM lead data for this project.' };
  const sentence = `${last} leads in the last 7 days, ${prev} the 7 before.`;
  if (last === 0 && prev > 0) return { state: 'red', sentence: `Leads stopped: ${sentence}` };
  if (last === 0) return { state: 'grey', sentence };
  return { state: last >= prev ? 'green' : 'amber', sentence };
}

/** After a revenue entry, suggest `earning` for its project when the evidence rule says so. */
export function suggestEarning(db: DB, projectId: string, now: Date) {
  const p = db.prepare('SELECT stage FROM projects WHERE id=?').get(projectId) as { stage: Stage } | undefined;
  if (!p) return null;
  const dates = (db.prepare('SELECT date FROM revenue WHERE project_id=?').all(projectId) as { date: string }[]).map(r => r.date);
  const s = proposeStage(p.stage, { revenue_dates: dates }, now);
  if (s) db.prepare('UPDATE projects SET stage_suggestion=?, stage_evidence=? WHERE id=?').run(s.stage, JSON.stringify([{ at: now.toISOString(), reason: s.evidence }]), projectId);
  return s?.stage ?? null;
}

export const GOAL_METRICS = ['revenue_monthly', 'projects_earning', 'leads_month', 'sites_live', 'custom'] as const;
export type GoalMetric = typeof GOAL_METRICS[number];
export interface GoalRow { id: number; period: string; metric: GoalMetric; target: number; unit: string | null; manual_value: number | null; label: string | null }
export const METRIC_LABEL: Record<GoalMetric, string> = {
  revenue_monthly: 'Revenue this month', projects_earning: 'Projects earning', leads_month: 'Leads this month', sites_live: 'Sites live', custom: 'Custom',
};

/** A goal's current value and a plain note on where the number comes from. */
export function goalValue(db: DB, goal: GoalRow, now: Date, timeZone: string): { value: number | null; source: string } {
  if (goal.metric === 'custom') return { value: goal.manual_value, source: goal.manual_value === null ? 'Set the value by hand.' : 'Entered by hand.' };
  if (goal.metric === 'revenue_monthly') {
    const currency = (CURRENCIES as readonly string[]).includes(goal.unit ?? '') ? goal.unit as Currency : 'USD';
    const s = moneySummary(db, currency, now, timeZone);
    return { value: Math.round(s.thisMonth), source: `Revenue entries dated this month, in ${currency}${s.missingRates.length ? `; set exchange rates for ${s.missingRates.join(', ')} to count them` : ''}.` };
  }
  if (goal.metric === 'projects_earning') {
    const since = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    const n = (db.prepare("SELECT count(*) AS n FROM projects WHERE stage='earning' OR id IN (SELECT project_id FROM revenue WHERE date >= ?)").get(since) as { n: number }).n;
    return { value: n, source: 'Projects at stage earning, or with revenue in the last 60 days.' };
  }
  if (goal.metric === 'leads_month') {
    if (!db.prepare('SELECT 1 FROM crm_leads_daily LIMIT 1').get()) return { value: goal.manual_value, source: 'No CRM data yet (see the VenderCRM task); showing the value set by hand.' };
    const month = monthOf(now, timeZone);
    return { value: (db.prepare('SELECT COALESCE(SUM(leads),0) AS n FROM crm_leads_daily WHERE substr(day,1,7)=?').get(month) as { n: number }).n, source: 'VenderCRM leads this month, all sites.' };
  }
  const live = (db.prepare(`SELECT count(DISTINCT c.host) AS n FROM domain_checks c JOIN domains d ON d.host=c.host AND d.project_id IS NOT NULL
    WHERE c.id=(SELECT id FROM domain_checks x WHERE x.host=c.host ORDER BY at DESC, id DESC LIMIT 1) AND c.status BETWEEN 200 AND 299 AND COALESCE(c.error_kind,'') <> 'PLACEHOLDER'`).get() as { n: number }).n;
  return { value: live, source: 'Project domains answering 200 with a real page at the last check.' };
}
