import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { jsx } from 'hono/jsx';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { DB } from '../db/index.js';
import { configSchema, type Config } from '../config.js';
import type { Collector } from '../collectors/types.js';
import { freshness } from '../collectors/freshness.js';
import { Layout, FreshnessTable } from './layout.js';
import { Board, Dot, StatusForms, type ProjectRow, type RepoRow, type LocalRow } from './views.js';
import { setProjectStatus } from '../portfolio/patch.js';
import { loadPortfolio } from '../portfolio/load.js';
import { syncPortfolio } from '../portfolio/sync.js';
import { redact } from '../lib/redact.js';
export interface WebOptions { db: DB; config: Config; collectors: Pick<Collector,'name'|'intervalMin'>[]; portfolioPath: string; now?: () => Date }
export function createApp({ db, config, collectors, portfolioPath, now = () => new Date() }: WebOptions) {
  configSchema.parse(config);
  const app = new Hono();
  const render = (title: string, child: unknown) => jsx(Layout, { title, redCount: (db.prepare("SELECT count(*) AS n FROM alerts WHERE severity='red' AND closed_at IS NULL").get() as {n:number}).n, freshness: freshness(db, collectors, now()), timeZone: config.owner_tz, children: child }).toString();
  const repos = () => db.prepare(`SELECT r.*,s.default_ci,s.last_commit_at,s.last_push_at,s.open_prs,s.stale_branches FROM repos r LEFT JOIN latest_gh_snapshot s ON s.repo=r.name`).all() as (RepoRow & {project_id:string})[];
  const local = () => db.prepare('SELECT * FROM latest_local_snapshot').all() as LocalRow[];
  app.get('/', c => {
    const alerts = db.prepare("SELECT * FROM alerts WHERE severity='red' AND closed_at IS NULL ORDER BY opened_at DESC").all() as {kind:string;subject:string;to_state:string}[];
    return c.html(render('Today', jsx('div', {}, jsx('h2', {}, 'Open red alerts'), alerts.length ? jsx('ul', {}, ...alerts.map(a => jsx('li', {}, `${a.kind}: ${a.subject} ${a.to_state ?? ''}`))) : jsx('p', {}, 'No open red alerts.'), jsx('p', {}, 'Ranked actions arrive in phase 3.'), jsx(FreshnessTable, {rows:freshness(db,collectors,now()),timeZone:config.owner_tz}))));
  });
  app.get('/portfolio', c => c.html(render('Portfolio', jsx(Board, { projects: db.prepare('SELECT * FROM projects ORDER BY name').all(), repos:repos(), local:local(), now:now(), all:c.req.query('all') === '1' }))));
  app.get('/project/:id', c => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(c.req.param('id')) as ProjectRow | undefined;
    if (!project) return c.text('Project not found', 404);
    const projectRepos = repos().filter(r => r.project_id === project.id);
    const domains = db.prepare('SELECT * FROM domains WHERE project_id=?').all(project.id) as {host:string;confidence:string;source:string}[];
    return c.html(render(project.name, jsx('div', {}, jsx('p', {}, `Stage: ${project.stage}`), jsx('p', {}, project.notes), jsx(StatusForms, {project}),
      ...projectRepos.map(r => jsx('section', {class:'panel'}, jsx('h2', {}, r.name), jsx(Dot, {state:r.default_ci ?? 'unknown',label:'CI'}), jsx('p', {}, `Last commit: ${r.last_commit_at ?? 'no data'}; last push: ${r.last_push_at ?? 'no data'}`),
        jsx('h3', {}, 'Open PRs'), jsx('pre', {}, JSON.stringify(JSON.parse(r.open_prs ?? '[]'),null,2)), jsx('h3', {}, 'Stale branches'), jsx('pre', {}, JSON.stringify(JSON.parse(r.stale_branches ?? '[]'),null,2)),
        jsx('h3', {}, 'Local checkouts'), ...local().filter(l => l.repo === r.name).map(l => jsx('p', {}, `${l.path}: ${l.branch ?? 'detached'}; ${l.dirty_files} dirty files, ${l.unpushed_commits} unpushed commits; ahead ${l.ahead}, behind ${l.behind}; observed ${l.at}`)))),
      jsx('h2', {}, 'Domains'), jsx('ul', {}, ...domains.map(d => jsx('li', {}, `${d.host} (${d.confidence ?? 'manual'}; ${d.source ?? 'portfolio'})`))))));
  });
  for (const action of ['pause','kill','resume'] as const) app.post(`/project/:id/${action}`, async c => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(c.req.param('id'))) return c.text('Project not found',404);
    const body = await c.req.parseBody();
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (action !== 'resume' && !reason.trim()) return c.text('A reason is required',400);
    try {
      const output = setProjectStatus(readFileSync(portfolioPath,'utf8'),c.req.param('id'),action === 'pause' ? 'paused' : action === 'kill' ? 'killed' : 'resume',reason);
      const parsed = loadPortfolio(output);
      writeFileSync(`${portfolioPath}.tmp`,output); renameSync(`${portfolioPath}.tmp`,portfolioPath);
      syncPortfolio(db,parsed,now().toISOString());
      return c.redirect('/portfolio',303);
    } catch (error) { return c.text(redact(error instanceof Error ? error.message : 'Status update failed'),400); }
  });
  app.get('/health', c => c.json({collectors:freshness(db,collectors,now())}));
  for (const [name,phase] of [['hosting',2],['inbox',3],['ideas',5],['goals',4],['review',5]] as const) app.get(`/${name}`,c => c.html(render(name,jsx('p',{},`Coming in phase ${phase}.`))));
  app.onError((_error,c) => c.text('Unable to render this page',500));
  return app;
}
export function listen(app: ReturnType<typeof createApp>, config: Config) {
  configSchema.parse(config);
  return serve({ fetch: app.fetch, hostname: config.host, port: config.port });
}
