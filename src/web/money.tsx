import type { Hono } from 'hono';
import type { DB } from '../db/index.js';
import { CURRENCIES, GOAL_METRICS, METRIC_LABEL, RECURRING, fxRates, goalValue, moneySummary, suggestEarning, type Currency, type GoalRow, type RevenueRow } from '../money/index.js';
import { SPEC_PATH } from '../collectors/crm/index.js';

type Render = (title: string, child: unknown) => string | Promise<string>;

const css = `.cards{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 20px}.cards div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:170px}
.cards strong{display:block;font-size:1.4rem}.goal{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:10px 0}
.bar{height:10px;background:var(--line);border-radius:6px;overflow:hidden;margin:8px 0}.bar span{display:block;height:100%;background:#1f8f4e}
.muted{color:var(--muted)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}.row label{display:flex;flex-direction:column;font-size:.85rem;gap:2px}
.row input,.row select{font:inherit;padding:5px 7px}button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:inherit;cursor:pointer}
button.primary{background:#1f5eff;border-color:#1f5eff;color:#fff}form.inline{display:inline}`;

const fmt = (n: number, currency?: string) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: currency === 'PYG' ? 0 : 2 }).format(n)}${currency ? ` ${currency}` : ''}`;

export function MoneyPage(props: {
  goals: (GoalRow & { value: number | null; source: string })[]; revenue: (RevenueRow & { project_name: string | null })[];
  summary: ReturnType<typeof moneySummary>; fx: ReturnType<typeof fxRates>; projects: { id: string; name: string }[];
  leads: { source: string; leads: number }[]; hasCrm: boolean; view: Currency; today: string; defaultPeriod: string;
}) {
  const { summary: s } = props;
  return <div><style>{css}</style>
    <h2>Goals</h2>
    {props.goals.length === 0 && <p class="muted">No goals yet. Set yearly and quarterly targets below: monthly revenue, projects earning, leads per month, sites live.</p>}
    {props.goals.map(g => {
      const pct = g.value === null || g.target <= 0 ? 0 : Math.min(100, Math.round((g.value / g.target) * 100));
      return <div class="goal"><strong>{g.label || METRIC_LABEL[g.metric]}</strong> <span class="muted">{g.period}</span>
        <div class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={`width:${pct}%`} /></div>
        <div>{g.value === null ? 'no value yet' : fmt(g.value, g.metric === 'revenue_monthly' ? (g.unit ?? 'USD') : undefined)} of {fmt(g.target, g.metric === 'revenue_monthly' ? (g.unit ?? 'USD') : undefined)} ({pct}%)</div>
        <p class="muted">{g.source}</p>
        <div class="row">{(g.metric === 'custom' || g.metric === 'leads_month') && <form method="post" action={`/goals/${g.id}/value`} class="row"><label>Value<input name="value" type="number" step="any" value={g.manual_value === null ? '' : String(g.manual_value)} /></label><button>Save</button></form>}
          <form method="post" action={`/goals/${g.id}/delete`} class="inline"><button>Delete</button></form></div>
      </div>;
    })}
    <form method="post" action="/goals" class="row"><label>Period<input name="period" required pattern="\d{4}(-Q[1-4])?" value={props.defaultPeriod} size={8} /></label>
      <label>Metric<select name="metric">{GOAL_METRICS.map(m => <option value={m}>{METRIC_LABEL[m]}</option>)}</select></label>
      <label>Target<input name="target" type="number" step="any" min="0" required /></label>
      <label>Unit (currency for revenue)<select name="unit"><option value="">-</option>{CURRENCIES.map(c => <option value={c}>{c}</option>)}</select></label>
      <label>Label (custom)<input name="label" maxlength={80} /></label><button class="primary">Add goal</button></form>

    <h2>Revenue</h2>
    <form method="get" action="/goals" class="row"><label>Show in<select name="in">{CURRENCIES.map(c => <option value={c} selected={c === props.view}>{c}</option>)}</select></label><button>Show</button></form>
    <div class="cards"><div>This month<strong>{fmt(s.thisMonth, s.currency)}</strong></div><div>Last 30 days<strong>{fmt(s.last30, s.currency)}</strong></div><div>Recurring per month<strong>{fmt(s.mrr, s.currency)}</strong></div></div>
    {s.missingRates.length > 0 && <p class="muted">Entries in {s.missingRates.join(', ')} are not counted until their exchange rate is set below.</p>}
    <form method="post" action="/revenue" class="row">
      <label>Project<select name="project_id"><option value="">-</option>{props.projects.map(p => <option value={p.id}>{p.name}</option>)}</select></label>
      <label>Client<input name="client" maxlength={120} /></label><label>Amount<input name="amount" type="number" step="any" min="0" required /></label>
      <label>Currency<select name="currency">{CURRENCIES.map(c => <option value={c} selected={c === 'PYG'}>{c}</option>)}</select></label>
      <label>Recurring<select name="recurring">{RECURRING.map(r => <option value={r}>{r}</option>)}</select></label>
      <label>Date<input name="date" type="date" required value={props.today} /></label><label>Note<input name="note" maxlength={200} /></label><button class="primary">Add</button></form>
    {props.revenue.length > 0 && <table><thead><tr><th>Date</th><th>Project</th><th>Client</th><th>Amount</th><th>Recurring</th><th /></tr></thead><tbody>
      {props.revenue.map(r => <tr><td>{r.date}</td><td>{r.project_name ?? '-'}</td><td>{r.client ?? ''}</td><td>{fmt(r.amount, r.currency)}</td><td>{r.recurring}</td>
        <td><form method="post" action={`/revenue/${r.id}/delete`} class="inline"><button>Delete</button></form></td></tr>)}</tbody></table>}
    <h3>Exchange rates (units per 1 USD)</h3>
    <form method="post" action="/fx" class="row">{(['PYG', 'SEK', 'EUR'] as const).map(c => <label>{c}<input name={c} type="number" step="any" min="0" value={props.fx[c] === null ? '' : String(props.fx[c])} /></label>)}<button>Save rates</button></form>

    <h2>Leads (VenderCRM, last 30 days)</h2>
    {props.hasCrm ? <table><thead><tr><th>Source</th><th>Leads</th></tr></thead><tbody>{props.leads.map(l => <tr><td>{l.source}</td><td>{l.leads}</td></tr>)}</tbody></table>
      : <p class="muted">No lead data yet. Either put a contacts feed token in <code>.env.local</code> as <code>VENDERCRM_FEED_TOKENS=label=token</code> (read and counted in memory, contact details never stored), or build the counts-only endpoint in <code>{SPEC_PATH}</code> and set <code>VENDERCRM_STATS_KEY</code>. A task for the endpoint is in the vendercrm project.</p>}
  </div>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => { const n = Number(typeof v === 'string' ? v.trim() : NaN); return typeof v === 'string' && v.trim() !== '' && Number.isFinite(n) ? n : null; };
const quarter = (now: Date, tz: string) => { const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(now).split('-'); return `${y}-Q${Math.ceil(Number(m) / 3)}`; };

export function registerMoneyRoutes(app: Hono, deps: { db: DB; render: Render; now: () => Date; timeZone: string; projects: () => { id: string; name: string }[] }) {
  const { db } = deps;
  app.get('/goals', c => {
    const now = deps.now(), q = c.req.query('in');
    const view: Currency = (CURRENCIES as readonly string[]).includes(q ?? '') ? q as Currency : 'USD';
    const goals = (db.prepare('SELECT * FROM goals ORDER BY period, id').all() as GoalRow[]).map(g => ({ ...g, ...goalValue(db, g, now, deps.timeZone) }));
    const since = new Intl.DateTimeFormat('en-CA', { timeZone: deps.timeZone }).format(new Date(now.getTime() - 30 * 86_400_000));
    return c.html(deps.render('Goals & money', <MoneyPage goals={goals} view={view} fx={fxRates(db)} projects={deps.projects()} summary={moneySummary(db, view, now, deps.timeZone)}
      revenue={db.prepare('SELECT r.*, p.name AS project_name FROM revenue r LEFT JOIN projects p ON p.id=r.project_id ORDER BY r.date DESC, r.id DESC LIMIT 100').all() as (RevenueRow & { project_name: string | null })[]}
      leads={db.prepare('SELECT crm_site AS source, SUM(leads) AS leads FROM crm_leads_daily WHERE day >= ? GROUP BY crm_site ORDER BY leads DESC').all(since) as { source: string; leads: number }[]}
      hasCrm={!!db.prepare('SELECT 1 FROM crm_leads_daily LIMIT 1').get()} today={new Intl.DateTimeFormat('en-CA', { timeZone: deps.timeZone }).format(now)} defaultPeriod={quarter(now, deps.timeZone)} />));
  });
  app.post('/goals', async c => {
    const b = await c.req.parseBody();
    const period = str(b.period, 7), metric = str(b.metric, 30), target = num(b.target), unit = str(b.unit, 3) || null;
    if (!/^\d{4}(-Q[1-4])?$/.test(period) || !(GOAL_METRICS as readonly string[]).includes(metric) || target === null || target < 0) return c.text('Period (2026 or 2026-Q4), metric and a target of 0 or more are required', 400);
    if (unit && !(CURRENCIES as readonly string[]).includes(unit)) return c.text('Unknown currency', 400);
    db.prepare('INSERT INTO goals(period,metric,target,unit,label,created_at) VALUES (?,?,?,?,?,?)').run(period, metric, target, metric === 'revenue_monthly' ? (unit ?? 'USD') : unit, str(b.label, 80) || null, deps.now().toISOString());
    return c.redirect('/goals', 303);
  });
  app.post('/goals/:id/value', async c => {
    const v = (await c.req.parseBody()).value, n = num(v);
    if (v !== '' && n === null) return c.text('Value must be a number', 400);
    if (!db.prepare('UPDATE goals SET manual_value=? WHERE id=?').run(n, Number(c.req.param('id'))).changes) return c.text('Goal not found', 404);
    return c.redirect('/goals', 303);
  });
  app.post('/goals/:id/delete', c => { db.prepare('DELETE FROM goals WHERE id=?').run(Number(c.req.param('id'))); return c.redirect('/goals', 303); });
  app.post('/revenue', async c => {
    const b = await c.req.parseBody();
    const amount = num(b.amount), currency = str(b.currency, 3), recurring = str(b.recurring, 10) || 'none', date = str(b.date, 10), project = str(b.project_id, 100) || null;
    if (amount === null || amount < 0 || !(CURRENCIES as readonly string[]).includes(currency) || !(RECURRING as readonly string[]).includes(recurring) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.text('Amount, currency, recurring and a date are required', 400);
    if (project && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) return c.text('Unknown project', 400);
    db.prepare('INSERT INTO revenue(project_id,client,amount,currency,recurring,date,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(project, str(b.client, 120) || null, amount, currency, recurring, date, str(b.note, 200) || null, deps.now().toISOString());
    if (project) suggestEarning(db, project, deps.now());
    return c.redirect('/goals', 303);
  });
  app.post('/revenue/:id/delete', c => { db.prepare('DELETE FROM revenue WHERE id=?').run(Number(c.req.param('id'))); return c.redirect('/goals', 303); });
  app.post('/fx', async c => {
    const b = await c.req.parseBody(), at = deps.now().toISOString();
    for (const cur of ['PYG', 'SEK', 'EUR'] as const) {
      const v = num(b[cur]);
      if (b[cur] === '' || b[cur] === undefined) continue;
      if (v === null || v <= 0) return c.text(`${cur} rate must be a positive number`, 400);
      db.prepare('INSERT INTO fx(currency,per_usd,set_at) VALUES (?,?,?) ON CONFLICT(currency) DO UPDATE SET per_usd=excluded.per_usd, set_at=excluded.set_at').run(cur, v, at);
    }
    return c.redirect('/goals', 303);
  });
}
