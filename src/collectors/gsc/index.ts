import type { DB } from '../../db/index.js';
import type { Collector } from '../types.js';
import { accessToken, gscClient, refreshToken, SECRETS_PATH, type GscClient, type PostForm, postForm } from '../../gsc/oauth.js';
import { matchProperty, queryBody, weekly, type ApiRow, type Site, type WeekRow } from './parse.js';
import { addDays, localDate } from '../../lib/clock.js';
import { redact } from '../../lib/redact.js';

/** Read-only Search Console API calls. Only GET sites and POST searchAnalytics/query (a read). */
export type GscFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: unknown }>;
const gscFetch: GscFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const API = 'https://www.googleapis.com/webmasters/v3';
export const WEEKS = 16;

export function storeWeeks(db: DB, rows: WeekRow[]) {
  const upsert = db.prepare('INSERT INTO gsc_weekly(host,week,clicks,impressions) VALUES (?,?,?,?) ON CONFLICT(host,week) DO UPDATE SET clicks=excluded.clicks,impressions=excluded.impressions');
  db.transaction(() => { for (const r of rows) upsert.run(r.host, r.week, r.clicks, r.impressions); })();
  return rows.length;
}

export interface GscDeps { client: () => GscClient | null; refresh: () => string | null; post: PostForm; fetch: GscFetch }
export const defaultGscDeps = (secretsPath = SECRETS_PATH): GscDeps => ({ client: () => gscClient(), refresh: () => refreshToken(secretsPath), post: postForm, fetch: gscFetch });

export function gscCollector(intervalMin = 1440, deps: GscDeps = defaultGscDeps()): Collector {
  return {
    name: 'gsc', intervalMin,
    async run(ctx) {
      const client = deps.client(), refresh = deps.refresh();
      if (!client || !refresh) { ctx.log.info('gsc: Search Console not connected (see /gsc); no data'); return 0; }
      const token = await accessToken(client, refresh, deps.post);
      const call = async (url: string, body?: unknown) => {
        const res = await deps.fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        if (res.status !== 200) throw new Error(redact(`Search Console answered HTTP ${res.status}`));
        return res.json;
      };
      const sites = ((await call(`${API}/sites`)) as { siteEntry?: Site[] } | null)?.siteEntry ?? [];
      // GSC data lags by about 2-3 days; the last full days are queried, whole weeks back.
      const end = addDays(localDate(ctx.now(), ctx.config.owner_tz), -3), start = addDays(end, -7 * WEEKS);
      let stored = 0;
      for (const { host } of ctx.db.prepare('SELECT host FROM domains WHERE project_id IS NOT NULL ORDER BY host').all() as { host: string }[]) {
        const property = matchProperty(host, sites);
        if (!property) continue;
        const json = await call(`${API}/sites/${encodeURIComponent(property.siteUrl)}/searchAnalytics/query`, queryBody(host, property, start, end)) as { rows?: ApiRow[] } | null;
        stored += storeWeeks(ctx.db, weekly(host, json?.rows ?? []));
      }
      return stored;
    },
  };
}
