import type { Hono } from 'hono';
import type { DB } from '../db/index.js';
import { authUrl, exchangeCode, gscClient, pkce, readSecrets, writeSecrets, type GscClient, type PostForm, postForm } from '../gsc/oauth.js';
import { redact } from '../lib/redact.js';

type Render = (title: string, child: unknown) => string | Promise<string>;
interface WeekRow { host: string; week: string; clicks: number; impressions: number }

/** Clicks and impressions for the project's domains, the last 8 weeks, with a small clicks sparkline. */
export function GscTrend({ rows }: { rows: WeekRow[] }) {
  if (!rows.length) return <p><small>No Search Console data yet. <a href="/gsc">Connect Search Console</a> or add the site as a property there.</small></p>;
  const hosts = [...new Set(rows.map(r => r.host))];
  return <>{hosts.map(host => {
    const own = rows.filter(r => r.host === host).slice(-8), max = Math.max(1, ...own.map(r => r.clicks));
    const points = own.map((r, i) => `${(i / Math.max(1, own.length - 1) * 160).toFixed(1)},${(38 - r.clicks / max * 34).toFixed(1)}`).join(' ');
    const last = own.at(-1), prev = own.at(-2);
    const trend = last && prev ? (last.clicks > prev.clicks ? 'up' : last.clicks < prev.clicks ? 'down' : 'flat') : 'new';
    return <div data-gsc={host}><strong>{host}</strong> <small>{last ? `${last.clicks} clicks, ${last.impressions} impressions in the week of ${last.week} (${trend} vs the week before)` : ''}</small>
      <svg viewBox="0 0 160 40" width="160" height="40" role="img" aria-label={`Weekly clicks for ${host}`}><polyline points={points} fill="none" stroke="#2563eb" stroke-width="2" /></svg>
      <table><thead><tr><th>Week</th><th>Clicks</th><th>Impressions</th></tr></thead><tbody>{own.slice().reverse().map(r => <tr><td>{r.week}</td><td>{r.clicks}</td><td>{r.impressions}</td></tr>)}</tbody></table></div>;
  })}</>;
}

export const projectGsc = (db: DB, projectId: string) =>
  db.prepare('SELECT g.host,g.week,g.clicks,g.impressions FROM gsc_weekly g JOIN domains d ON d.host=g.host WHERE d.project_id=? ORDER BY g.host,g.week').all(projectId) as WeekRow[];

export interface GscRouteDeps { db: DB; render: Render; port: number; secretsPath: string; client?: () => GscClient | null; post?: PostForm; now: () => Date }

/** /gsc: connect (loopback OAuth with PKCE), callback, disconnect, and a status line. */
export function registerGscRoutes(app: Hono, deps: GscRouteDeps) {
  const client = deps.client ?? (() => gscClient());
  const redirectUri = `http://127.0.0.1:${deps.port}/gsc/callback`;
  const pending = new Map<string, { verifier: string; at: number }>();
  const page = (message?: string) => {
    const c = client(), connected = readSecrets(deps.secretsPath).gsc;
    const weeks = (deps.db.prepare('SELECT count(*) AS n, count(DISTINCT host) AS hosts, max(week) AS latest FROM gsc_weekly').get() as { n: number; hosts: number; latest: string | null });
    return deps.render('Search Console', <div>
      {message && <p class="panel">{message}</p>}
      {!c ? <p>Set <code>GSC_CLIENT_ID</code> and <code>GSC_CLIENT_SECRET</code> in <code>.env.local</code> (a Google Cloud OAuth client of type "Desktop app" with the Search Console API enabled), then restart.</p>
        : connected ? <><p>Connected since {connected.connected_at.slice(0, 10)}. The gsc collector reads weekly clicks and impressions once a day (read-only scope).</p>
          <form method="post" action="/gsc/disconnect"><button>Disconnect</button></form></>
        : <p><a href="/gsc/connect">Connect Search Console</a> (opens Google, then returns to 127.0.0.1).</p>}
      <p><small>{weeks.n} weekly rows for {weeks.hosts} domains{weeks.latest ? `, latest week ${weeks.latest}` : ''}.</small></p>
    </div>);
  };
  app.get('/gsc', c => c.html(page()));
  app.get('/gsc/connect', c => {
    const cl = client();
    if (!cl) return c.html(page('Search Console client is not configured.'), 400);
    const { verifier, challenge, state } = pkce();
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
    pending.set(state, { verifier, at: Date.now() });
    return c.redirect(authUrl(cl, redirectUri, state, challenge), 302);
  });
  app.get('/gsc/callback', async c => {
    const cl = client(), state = c.req.query('state') ?? '', code = c.req.query('code'), flow = pending.get(state);
    if (c.req.query('error')) return c.html(page(`Google said: ${redact(c.req.query('error') ?? '')}`), 400);
    if (!cl || !code || !flow) return c.html(page('This sign-in link is not valid or has expired. Start again.'), 400);
    pending.delete(state);
    try {
      const token = await exchangeCode(cl, code, flow.verifier, redirectUri, deps.post ?? postForm);
      writeSecrets({ ...readSecrets(deps.secretsPath), gsc: { refresh_token: token, connected_at: deps.now().toISOString() } }, deps.secretsPath);
    } catch (error) { return c.html(page(redact(error instanceof Error ? error.message : 'Sign-in failed')), 400); }
    return c.redirect('/gsc', 303);
  });
  app.post('/gsc/disconnect', c => {
    const secrets = readSecrets(deps.secretsPath);
    delete secrets.gsc;
    writeSecrets(secrets, deps.secretsPath);
    return c.redirect('/gsc', 303);
  });
}
