import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { jsx } from 'hono/jsx';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { DB } from '../db/index.js';
import { configSchema, type Config } from '../config.js';
import type { Collector } from '../collectors/types.js';
import { freshness } from '../collectors/freshness.js';
import { Layout } from './layout.js';
import { Board, Dot, RepoPanel, StatusForms, type ProjectRow, type RepoRow, type LocalRow } from './views.js';
import { setProjectStatus } from '../portfolio/patch.js';
import { loadPortfolio } from '../portfolio/load.js';
import { syncPortfolio } from '../portfolio/sync.js';
import { redact } from '../lib/redact.js';
import { Hosting } from './hosting.js';
import { DomainDetails, projectChecks, siteSignal } from './domains.js';
import { alertSentence, evaluate } from '../alerts/index.js';
import { activeStages } from '../portfolio/schema.js';
import { registerTodayRoutes, ProjectWork, projectWork } from './today.js';
import { registerMoneyRoutes } from './money.js';
import { registerRhythmRoutes } from './review.js';
import { leadsSignal } from '../money/index.js';
import type { AiDeps, MessagesLike } from '../ai/client.js';
import { log } from '../lib/log.js';
export interface WebOptions { db: DB; config: Config; collectors: Pick<Collector,'name'|'intervalMin'>[]; portfolioPath: string; now?: () => Date; aiClient?: MessagesLike | null }
export function createApp({ db, config, collectors, portfolioPath, now = () => new Date(), aiClient }: WebOptions) {
  configSchema.parse(config);
  const app = new Hono();
  const render = (title: string, child: unknown) => jsx(Layout, { title, redCount: (db.prepare("SELECT count(*) AS n FROM alerts WHERE severity='red' AND closed_at IS NULL").get() as {n:number}).n, freshness: freshness(db, collectors, now()), timeZone: config.owner_tz, children: child }).toString();
  const repos = () => db.prepare(`SELECT r.*,s.default_ci,s.last_commit_at,s.last_push_at,s.open_prs,s.stale_branches FROM repos r LEFT JOIN latest_gh_snapshot s ON s.repo=r.name`).all() as (RepoRow & {project_id:string})[];
  const local = () => db.prepare('SELECT * FROM latest_local_snapshot').all() as LocalRow[];
  const ai: AiDeps = { db, config: config.ai, timeZone: config.owner_tz, now, log, client: aiClient };
  registerTodayRoutes(app, { db, ai, githubOwner: config.github_owner, timeZone: config.owner_tz, now, render,
    projects: () => db.prepare("SELECT id, name FROM projects WHERE stage <> 'killed' ORDER BY name").all() as { id: string; name: string }[] });
  registerMoneyRoutes(app, { db, render, now, timeZone: config.owner_tz,
    projects: () => db.prepare("SELECT id, name FROM projects WHERE stage <> 'killed' ORDER BY name").all() as { id: string; name: string }[] });
  // Every yaml write goes through here: validated by the caller, written atomically, then synced.
  const writePortfolio = (text: string) => {
    const parsed = loadPortfolio(text);
    writeFileSync(`${portfolioPath}.tmp`,text); renameSync(`${portfolioPath}.tmp`,portfolioPath);
    syncPortfolio(db,parsed,now().toISOString());
  };
  registerRhythmRoutes(app, { db, ai, timeZone: config.owner_tz, now, render, readPortfolio: () => readFileSync(portfolioPath,'utf8'), writePortfolio });
  app.get('/portfolio', c => c.html(render('Portfolio', jsx(Board, { projects: (db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[]).map(p => ({...p,site:siteSignal(projectChecks(db,p.id),now()),leads:leadsSignal(db,p.id,now(),config.owner_tz)})), repos:repos(), local:local(), now:now(), all:c.req.query('all') === '1' }))));
  app.get('/project/:id', c => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(c.req.param('id')) as ProjectRow | undefined;
    if (!project) return c.text('Project not found', 404);
    const projectRepos = repos().filter(r => r.project_id === project.id);
    const checks = projectChecks(db,project.id), site = siteSignal(checks,now());
    return c.html(render(project.name, jsx('div', {}, jsx('p', {}, `Stage: ${project.stage}`), jsx('p', {}, project.notes), jsx(StatusForms, {project}),
      ...projectRepos.map(r => jsx(RepoPanel, {repo:r, local:local().filter(l => l.repo === r.name), now:now()})),
      jsx(ProjectWork, projectWork(db, project.id)), jsx(Dot,{state:site.state,label:'Site',title:site.sentence}), jsx('h2', {}, 'Domains'), jsx(DomainDetails,{checks,now:now()}), project.stage_suggestion ? jsx('form',{method:'post',action:`/project/${encodeURIComponent(project.id)}/accept-stage`},jsx('p',{},`Evidence says ${project.stage_suggestion}: ${(JSON.parse(project.stage_evidence ?? '[]') as {host?:string;reason?:string}[]).map(e => `${e.host ?? ''}: ${e.reason ?? ''}`).join('; ')}`),jsx('button',{},'Accept?')) : null)));
  });
  // Writes every accepted upward suggestion to portfolio.yaml in one pass. Returns how many were applied.
  const acceptStages = (ids: string[]) => {
    type Active = typeof activeStages[number];
    let text = readFileSync(portfolioPath,'utf8'); const accepted: string[] = [];
    for (const id of ids) {
      const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow | undefined;
      const target = project?.stage_suggestion as Active | undefined;
      const current = loadPortfolio(text).projects.find(p => p.id === id);
      if (!project || !target || !current || !activeStages.includes(target) || !activeStages.includes(current.stage as Active) || activeStages.indexOf(target) <= activeStages.indexOf(current.stage as Active)) continue;
      text = setProjectStatus(text,id,target); accepted.push(id);
    }
    if (!accepted.length) return 0;
    writePortfolio(text);
    const clear = db.prepare("UPDATE projects SET stage_suggestion=NULL,stage_evidence='[]' WHERE id=?");
    for (const id of accepted) clear.run(id);
    return accepted.length;
  };
  app.post('/project/:id/accept-stage',c => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(c.req.param('id'))) return c.text('Project not found',404);
    if (!acceptStages([c.req.param('id')])) return c.text('No upward stage suggestion to accept',400);
    return c.redirect(`/project/${encodeURIComponent(c.req.param('id'))}`,303);
  });
  app.post('/portfolio/accept-stages',c => {
    const ids = (db.prepare("SELECT id FROM projects WHERE stage_suggestion IS NOT NULL AND stage NOT IN ('paused','killed')").all() as {id:string}[]).map(r => r.id);
    acceptStages(ids);
    return c.redirect('/portfolio',303);
  });
  app.get('/hosting',c => c.html(render('Hosting',jsx(Hosting,{db,now:now()}))));
  app.post('/hosting/:id/manual',async c => {
    if (!db.prepare('SELECT 1 FROM hosting_accounts WHERE id=?').get(c.req.param('id'))) return c.text('Hosting account not found',404);
    const body = await c.req.parseBody(), value = body.processes;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 1_000_000) return c.text('Enter a whole process count from 0 to 1000000',400);
    db.prepare("INSERT INTO process_samples(account_id,at,procs,threads,node_apps,source) VALUES (?,?,?,NULL,'[]','manual')").run(c.req.param('id'),now().toISOString(),Number(value));
    evaluate(db,collectors,now());
    return c.redirect('/hosting',303);
  });
  for (const action of ['pause','kill','resume'] as const) app.post(`/project/:id/${action}`, async c => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(c.req.param('id'))) return c.text('Project not found',404);
    const body = await c.req.parseBody();
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (action !== 'resume' && !reason.trim()) return c.text('A reason is required',400);
    try {
      const output = setProjectStatus(readFileSync(portfolioPath,'utf8'),c.req.param('id'),action === 'pause' ? 'paused' : action === 'kill' ? 'killed' : 'resume',reason);
      writePortfolio(output);
      return c.redirect('/portfolio',303);
    } catch (error) { return c.text(redact(error instanceof Error ? error.message : 'Status update failed'),400); }
  });
  app.get('/health', c => c.json({collectors:freshness(db,collectors,now())}));
  app.onError((_error,c) => c.text('Unable to render this page',500));
  return app;
}
export function listen(app: ReturnType<typeof createApp>, config: Config) {
  configSchema.parse(config);
  return serve({ fetch: app.fetch, hostname: config.host, port: config.port });
}
