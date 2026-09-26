import type { DB } from '../db/index.js';
import { alertSentence } from '../alerts/index.js';
import { lastActivity } from '../today/service.js';
import { projectLeads, type Currency } from '../money/index.js';
import { activeStages } from '../portfolio/schema.js';
import { redact } from '../lib/redact.js';
import { localDate, weekKey, addDays } from '../lib/clock.js';
import { writeWeekly } from '../ai/purposes.js';
import type { AiDeps } from '../ai/client.js';

/**
 * The Sunday review (PLAN.md §8). The facts are deterministic and computed from the database;
 * the AI may only write prose over them. Ported in spirit from v3's lib/report/weekly.ts:
 * what landed, what changed stage, and what is closest to money now.
 */

const DAY = 86_400_000;
const STALL_STAGES = ['building', 'deployed', 'live'];
const BELOW_LIVE = ['building', 'deployed'];

export interface WeeklyFacts {
  week: string; // Monday of the reviewed week, owner timezone
  from: string; to: string; // the 7 days covered, as ISO instants
  shipped: {
    deploys: { repo: string; merged_prs: number[]; pushes: number }[];
    stage_raises: { project_id: string; name: string; from: string | null; to: string; at: string }[];
    tasks_done: { title: string; project: string | null }[];
  };
  broke: { alerts: { sentence: string; severity: string; opened_at: string; closed_at: string | null }[] };
  earned: {
    revenue: { project: string | null; client: string | null; amount: number; currency: Currency; date: string }[];
    totals: { currency: Currency; amount: number }[];
    leads: { project: string; leads: number }[];
    leads_total: number | null;
  };
  stalled: { project_id: string; name: string; stage: string; days: number | null; money_weight: number }[];
  kills: { project_id: string; name: string; stage: string; days: number | null; money_weight: number }[];
}

export function weeklyFacts(db: DB, now: Date, timeZone: string, week?: string): WeeklyFacts {
  const from = new Date(now.getTime() - 7 * DAY).toISOString(), to = now.toISOString();
  const today = localDate(now, timeZone), firstDay = addDays(today, -6);
  const names = new Map((db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[]).map(p => [p.id, p.name]));

  const deploys = new Map<string, { repo: string; merged_prs: number[]; pushes: number }>();
  for (const d of db.prepare('SELECT repo, pr_number, source FROM deploys WHERE at >= ? AND at <= ? ORDER BY at').all(from, to) as { repo: string; pr_number: number | null; source: string }[]) {
    const row = deploys.get(d.repo) ?? { repo: d.repo, merged_prs: [], pushes: 0 };
    if (d.source === 'merged PR' && d.pr_number != null) row.merged_prs.push(d.pr_number); else row.pushes++;
    deploys.set(d.repo, row);
  }
  const raises = (db.prepare('SELECT project_id, from_stage, to_stage, at FROM stage_changes WHERE at >= ? AND at <= ? ORDER BY at').all(from, to) as { project_id: string; from_stage: string | null; to_stage: string; at: string }[])
    .filter(c => (activeStages as readonly string[]).includes(c.to_stage) && (activeStages as readonly string[]).indexOf(c.to_stage) > (activeStages as readonly string[]).indexOf(c.from_stage ?? ''))
    .map(c => ({ project_id: c.project_id, name: names.get(c.project_id) ?? c.project_id, from: c.from_stage, to: c.to_stage, at: c.at }));
  const tasksDone = (db.prepare("SELECT title, project_id FROM tasks WHERE status='done' AND done_at >= ? AND done_at <= ? ORDER BY done_at").all(from, to) as { title: string; project_id: string | null }[])
    .map(t => ({ title: redact(t.title), project: t.project_id ? names.get(t.project_id) ?? t.project_id : null }));

  const alerts = (db.prepare('SELECT kind, subject, severity, opened_at, closed_at FROM alerts WHERE (opened_at >= ? AND opened_at <= ?) OR closed_at IS NULL ORDER BY severity DESC, opened_at').all(from, to) as { kind: string; subject: string; severity: string; opened_at: string; closed_at: string | null }[])
    .map(a => ({ sentence: alertSentence(db, a, now), severity: a.severity, opened_at: a.opened_at, closed_at: a.closed_at }));

  const revenue = (db.prepare('SELECT project_id, client, amount, currency, date FROM revenue WHERE date BETWEEN ? AND ? ORDER BY date').all(firstDay, today) as { project_id: string | null; client: string | null; amount: number; currency: Currency; date: string }[])
    .map(r => ({ project: r.project_id ? names.get(r.project_id) ?? r.project_id : null, client: r.client ? redact(r.client) : null, amount: r.amount, currency: r.currency, date: r.date }));
  const totals = new Map<Currency, number>();
  for (const r of revenue) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amount);
  const hasLeads = !!db.prepare('SELECT 1 FROM crm_leads_daily LIMIT 1').get();
  const leads = hasLeads ? [...names.keys()].map(id => ({ project: names.get(id)!, leads: projectLeads(db, id, firstDay, today) ?? 0 })).filter(l => l.leads > 0).sort((a, b) => b.leads - a.leads) : [];
  const leadsTotal = hasLeads ? (db.prepare('SELECT COALESCE(SUM(leads),0) AS n FROM crm_leads_daily WHERE day BETWEEN ? AND ?').get(firstDay, today) as { n: number }).n : null;

  const activity = lastActivity(db);
  const stalled = (db.prepare(`SELECT id, name, stage, money_weight FROM projects WHERE stage IN (${STALL_STAGES.map(() => '?').join(',')}) ORDER BY name`).all(...STALL_STAGES) as { id: string; name: string; stage: string; money_weight: number }[])
    .map(p => { const last = activity.get(p.id); return { project_id: p.id, name: p.name, stage: p.stage, money_weight: p.money_weight, days: last ? Math.floor((now.getTime() - last) / DAY) : null }; })
    .filter(p => p.days === null || p.days >= 14)
    .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity) || a.name.localeCompare(b.name));
  const kills = stalled.filter(p => (p.days === null || p.days >= 30) && BELOW_LIVE.includes(p.stage) && p.money_weight <= 2);

  return {
    week: week ?? weekKey(today), from, to,
    shipped: { deploys: [...deploys.values()], stage_raises: raises, tasks_done: tasksDone },
    broke: { alerts },
    earned: { revenue, totals: [...totals].map(([currency, amount]) => ({ currency, amount })), leads, leads_total: leadsTotal },
    stalled, kills,
  };
}

const amount = (n: number, c: string) => `${Math.round(n).toLocaleString('en-US')} ${c}`;
const since = (days: number | null) => days === null ? 'no activity recorded' : `${days} days quiet`;

/** A one-line headline from the facts, used when the AI is off. */
export function headline(f: WeeklyFacts): string {
  const shipped = f.shipped.deploys.reduce((n, d) => n + d.merged_prs.length + d.pushes, 0);
  const earned = f.earned.totals.map(t => amount(t.amount, t.currency)).join(' + ') || 'no revenue';
  return `Week of ${f.week}: ${shipped} deploys, ${f.broke.alerts.length} alerts, ${earned}, ${f.stalled.length} stalled`;
}

/** The deterministic sections as plain-text lines, grouped by heading. */
export function sections(f: WeeklyFacts): { title: string; lines: string[] }[] {
  const s = f.shipped;
  return [
    { title: 'Shipped', lines: [
      ...s.deploys.map(d => `${d.repo}: ${[d.merged_prs.length ? `merged ${d.merged_prs.map(n => `#${n}`).join(', ')}` : '', d.pushes ? `${d.pushes} direct ${d.pushes === 1 ? 'push' : 'pushes'}` : ''].filter(Boolean).join(', ')}`),
      ...s.stage_raises.map(r => `${r.name} moved up: ${r.from ?? 'new'} → ${r.to}`),
      ...(s.tasks_done.length ? [`${s.tasks_done.length} tasks done: ${s.tasks_done.slice(0, 8).map(t => t.title).join('; ')}${s.tasks_done.length > 8 ? '; …' : ''}`] : []),
    ] },
    { title: 'Broke', lines: f.broke.alerts.map(a => `${a.severity === 'red' ? 'RED ' : ''}${a.sentence}${a.closed_at ? ' (fixed)' : ' (still open)'}`) },
    { title: 'Earned', lines: [
      ...f.earned.revenue.map(r => `${r.date} ${r.project ?? 'no project'}${r.client ? ` (${r.client})` : ''}: ${amount(r.amount, r.currency)}`),
      ...(f.earned.totals.length ? [`Total: ${f.earned.totals.map(t => amount(t.amount, t.currency)).join(' + ')}`] : []),
      f.earned.leads_total === null ? 'Leads: no CRM data yet' : `Leads: ${f.earned.leads_total}${f.earned.leads.length ? ` (${f.earned.leads.map(l => `${l.project} ${l.leads}`).join(', ')})` : ''}`,
    ] },
    { title: 'Stalled 14+ days', lines: f.stalled.map(p => `${p.name} (${p.stage}): ${since(p.days)}`) },
    { title: 'Suggested kills', lines: f.kills.map(p => `${p.name} (${p.stage}, weight ${p.money_weight}): ${since(p.days)}. Pause or kill it on /review.`) },
  ];
}

export interface StoredReview { id: number; week: string; generated_at: string; facts: string; headline: string; body: string; ai: number; sent_at: string | null }

/** Build the review for the week ending now, add AI prose when available, and store it (one row per week). */
export async function generateReview(db: DB, ai: AiDeps, now: Date, timeZone: string, week?: string): Promise<StoredReview> {
  const facts = weeklyFacts(db, now, timeZone, week);
  const prose = await writeWeekly(ai, { ...facts, sections: sections(facts) });
  const head = prose?.headline ? redact(prose.headline) : headline(facts);
  const body = prose?.body ? redact(prose.body) : '';
  db.prepare(`INSERT INTO reviews(week,generated_at,facts,headline,body,ai) VALUES (?,?,?,?,?,?)
    ON CONFLICT(week) DO UPDATE SET generated_at=excluded.generated_at,facts=excluded.facts,headline=excluded.headline,body=excluded.body,ai=excluded.ai`)
    .run(facts.week, now.toISOString(), JSON.stringify(facts), head, body, prose ? 1 : 0);
  return db.prepare('SELECT * FROM reviews WHERE week=?').get(facts.week) as StoredReview;
}
