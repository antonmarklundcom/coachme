import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchProperty, queryBody, weekly } from '../src/collectors/gsc/parse.js';
import { gscCollector, type GscDeps } from '../src/collectors/gsc/index.js';
import { authUrl, exchangeCode, pkce, readSecrets, SCOPE, type PostForm } from '../src/gsc/oauth.js';
import { createApp } from '../src/web/server.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { backupDb } from '../src/lib/backup.js';
import { compact } from '../src/db/compact.js';
import { openDb } from '../src/db/index.js';
import { seed } from '../scripts/bench-seed.js';
import { config, fixture, testDb, tempDir } from './helpers.js';

const now = new Date('2026-09-26T12:00:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const client = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'fake-client-secret-value' };
const sites = JSON.parse(fixture('gsc/sites.json')).siteEntry;

describe('search console parsing', () => {
  it('matches URL-prefix properties first, then domain properties filtered to the host', () => {
    expect(matchProperty('www.example.se', sites)).toEqual({ siteUrl: 'https://www.example.se/', hostFilter: false });
    expect(matchProperty('propia.com.py', sites)).toEqual({ siteUrl: 'sc-domain:propia.com.py', hostFilter: true });
    expect(matchProperty('app.propia.com.py', sites)).toEqual({ siteUrl: 'sc-domain:propia.com.py', hostFilter: true });
    expect(matchProperty('unverified.com', sites)).toBeNull();
    expect(matchProperty('other.com', sites)).toBeNull();
    expect(queryBody('propia.com.py', { siteUrl: 'sc-domain:propia.com.py', hostFilter: true }, '2026-06-01', '2026-09-23').dimensionFilterGroups?.[0].filters[0].expression).toBe('^https?://propia\\.com\\.py(/|$)');
    expect(queryBody('www.example.se', { siteUrl: 'https://www.example.se/', hostFilter: false }, 'a', 'b')).not.toHaveProperty('dimensionFilterGroups');
  });

  it('sums daily rows into Monday weeks', () => {
    expect(weekly('propia.com.py', JSON.parse(fixture('gsc/query.json')).rows)).toEqual([
      { host: 'propia.com.py', week: '2026-09-07', clicks: 5, impressions: 75 },
      { host: 'propia.com.py', week: '2026-09-14', clicks: 6, impressions: 82 },
      { host: 'propia.com.py', week: '2026-09-21', clicks: 7, impressions: 90 },
    ]);
  });
});

describe('search console collector', () => {
  const ctx = (db: ReturnType<typeof testDb>) => ({ db, config, now: () => now, exec: vi.fn(), log });

  it('does nothing and stays healthy when not connected', async () => {
    const db = testDb(), fetch = vi.fn();
    const deps: GscDeps = { client: () => client, refresh: () => null, post: vi.fn(), fetch };
    expect(await gscCollector(1440, deps).run(ctx(db))).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes the token, reads sites and weekly clicks read-only, and stores weeks per project domain', async () => {
    const db = testDb(); syncPortfolio(db, loadPortfolio(fixture('portfolio.yaml')));
    const post: PostForm = vi.fn(async (_url, form) => { expect(form.grant_type).toBe('refresh_token'); return { status: 200, json: { access_token: 'ya29.fake' } }; });
    const calls: { url: string; method: string }[] = [];
    const fetch: GscDeps['fetch'] = async (url, init) => {
      calls.push({ url, method: init.method });
      expect(init.headers.Authorization).toBe('Bearer ya29.fake');
      return { status: 200, json: url.endsWith('/sites') ? JSON.parse(fixture('gsc/sites.json')) : JSON.parse(fixture('gsc/query.json')) };
    };
    expect(await gscCollector(1440, { client: () => client, refresh: () => 'refresh', post, fetch }).run(ctx(db))).toBe(3);
    expect(calls.map(c => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1].url).toContain(`/sites/${encodeURIComponent('sc-domain:propia.com.py')}/searchAnalytics/query`);
    expect(calls.every(c => /\/sites($|\/[^/]+\/searchAnalytics\/query$)/.test(c.url))).toBe(true);
    expect(db.prepare('SELECT host, week, clicks FROM gsc_weekly ORDER BY week').all()).toHaveLength(3);
    // A rerun updates the same weeks instead of adding rows.
    await gscCollector(1440, { client: () => client, refresh: () => 'refresh', post, fetch }).run(ctx(db));
    expect(db.prepare('SELECT count(*) AS n FROM gsc_weekly').get()).toEqual({ n: 3 });
  });

  it('fails with a redacted message when Google refuses', async () => {
    const db = testDb(), post: PostForm = async () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const error = await gscCollector(1440, { client: () => client, refresh: () => 'refresh', post, fetch: vi.fn() }).run(ctx(db)).catch(e => e as Error);
    expect(error.message).toContain('invalid_grant');
    expect(error.message).not.toContain(client.clientSecret);
  });
});

describe('search console oauth', () => {
  function setup(post?: PostForm) {
    const db = testDb(), dir = tempDir(), portfolioPath = join(dir, 'portfolio.yaml'), secretsPath = join(dir, 'secrets.json');
    writeFileSync(portfolioPath, fixture('portfolio.yaml')); syncPortfolio(db, loadPortfolio(fixture('portfolio.yaml')));
    const app = createApp({ db, config, portfolioPath, collectors: [], now: () => now, aiClient: null, secretsPath, gscClient: () => client, gscPost: post });
    return { db, app, secretsPath };
  }

  it('builds a read-only PKCE authorization URL with a 127.0.0.1 redirect', async () => {
    const { verifier, challenge, state } = pkce();
    expect(verifier).not.toBe(challenge);
    const url = new URL(authUrl(client, 'http://127.0.0.1:4000/gsc/callback', state, challenge));
    expect(url.searchParams.get('scope')).toBe(SCOPE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const { app } = setup();
    const res = await app.request('/gsc/connect');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4000/gsc/callback');
    expect(location.searchParams.get('access_type')).toBe('offline');
  });

  it('rejects a callback with an unknown state and stores the refresh token git-ignored on success', async () => {
    const post: PostForm = vi.fn(async (_url, form) => {
      expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'http://127.0.0.1:4000/gsc/callback' });
      expect(form.code_verifier.length).toBeGreaterThan(40);
      return { status: 200, json: { refresh_token: '1//fake-refresh-token', access_token: 'x' } };
    });
    const { app, secretsPath } = setup(post);
    expect((await app.request('/gsc/callback?code=x&state=forged')).status).toBe(400);
    expect(existsSync(secretsPath)).toBe(false);
    const state = new URL((await app.request('/gsc/connect')).headers.get('location')!).searchParams.get('state')!;
    const res = await app.request(`/gsc/callback?code=the-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(303);
    expect(readSecrets(secretsPath).gsc?.refresh_token).toBe('1//fake-refresh-token');
    const page = await (await app.request('/gsc')).text();
    expect(page).toContain('Connected since');
    expect(page).not.toContain('fake-refresh-token');
    expect((await app.request(`/gsc/callback?code=the-code&state=${encodeURIComponent(state)}`)).status).toBe(400); // state is single-use
    await app.request('/gsc/disconnect', { method: 'POST' });
    expect(readSecrets(secretsPath).gsc).toBeUndefined();
    expect(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')).toContain('data/secrets.json');
  });

  it('reports a refused exchange without the client secret', async () => {
    await expect(exchangeCode(client, 'c', 'v', 'r', async () => ({ status: 401, json: { error: 'invalid_client' } }))).rejects.toThrow('invalid_client');
  });

  it('shows weekly search trends on the project page', async () => {
    const { db, app } = setup();
    db.prepare("INSERT INTO gsc_weekly(host,week,clicks,impressions) VALUES ('propia.com.py','2026-09-14',6,82),('propia.com.py','2026-09-21',9,90)").run();
    const html = await (await app.request('/project/propia')).text();
    expect(html).toContain('data-gsc="propia.com.py"');
    expect(html).toContain('9 clicks, 90 impressions in the week of 2026-09-21 (up vs the week before)');
  });
});

describe('backup and compaction', () => {
  it('backs up to a dated file and keeps the newest 14', async () => {
    const db = testDb(), dir = tempDir();
    db.prepare("INSERT INTO inbox(text,source,created_at) VALUES ('keep me','cli','x')").run();
    for (let d = 1; d <= 20; d++) writeFileSync(join(dir, `coach-2026-08-${String(d).padStart(2, '0')}.db`), '');
    const { path, removed } = await backupDb(db, dir, now, 'America/Asuncion');
    expect(path).toBe(join(dir, 'coach-2026-09-26.db'));
    expect(removed).toHaveLength(7);
    expect(readdirSync(dir)).toHaveLength(14);
    const copy = openDb(path);
    expect(copy.prepare('SELECT text FROM inbox').get()).toEqual({ text: 'keep me' });
    copy.close();
  });

  it('thins snapshots older than 30 days to one per subject per day and keeps recent rows and the latest view', () => {
    const db = testDb();
    const gh = db.prepare("INSERT INTO gh_snapshots(repo,at,open_prs,default_ci,stale_branches) VALUES (?,?,'[]','green','[]')");
    for (let h = 0; h < 24 * 60; h += 6) gh.run('r', new Date(now.getTime() - h * 3_600_000).toISOString());
    const before = db.prepare('SELECT * FROM latest_gh_snapshot').all();
    const recent = (db.prepare('SELECT count(*) AS n FROM gh_snapshots WHERE at >= ?').get(new Date(now.getTime() - 30 * 86_400_000).toISOString()) as { n: number }).n;
    expect(compact(db, now)).toBeGreaterThan(0);
    expect(db.prepare('SELECT * FROM latest_gh_snapshot').all()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM gh_snapshots WHERE at >= ?').get(new Date(now.getTime() - 30 * 86_400_000).toISOString())).toEqual({ n: recent });
    const old = db.prepare('SELECT substr(at,1,10) AS day, count(*) AS n FROM gh_snapshots WHERE at < ? GROUP BY day').all(new Date(now.getTime() - 30 * 86_400_000).toISOString()) as { n: number }[];
    expect(old.length).toBeGreaterThan(20);
    expect(old.every(r => r.n === 1)).toBe(true);
  });
});

describe('speed', () => {
  it('renders Today under 200 ms on a month of real-shaped data', async () => {
    const db = testDb(), t = new Date(); seed(db, t);
    const app = createApp({ db, config, portfolioPath: join(tempDir(), 'none.yaml'), collectors: ['github', 'local', 'domains', 'hostinger', 'notes', 'sessions', 'crm', 'gsc'].map(name => ({ name, intervalMin: 30 })), now: () => t, aiClient: null });
    await app.request('/');
    const times: number[] = [];
    for (let i = 0; i < 5; i++) { const s = performance.now(); expect((await app.request('/')).status).toBe(200); times.push(performance.now() - s); }
    expect(times.sort((a, b) => a - b)[2]).toBeLessThan(200);
  }, 30_000);
});
