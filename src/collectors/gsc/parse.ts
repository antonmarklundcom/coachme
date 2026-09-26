import { weekKey } from '../../lib/clock.js';

/** Pure parts of the Search Console collector: property matching and weekly roll-up. */

export interface Site { siteUrl: string; permissionLevel?: string }
export interface Property { siteUrl: string; hostFilter: boolean }

/**
 * The Search Console property that covers a host. A URL-prefix property for the exact host
 * wins; otherwise a domain property (sc-domain:) for the host or its parent, which is then
 * filtered to this host's pages so a www and an apex entry are not double-counted.
 */
export function matchProperty(host: string, sites: Site[]): Property | null {
  const usable = sites.filter(s => s.permissionLevel !== 'siteUnverifiedUser').map(s => s.siteUrl.toLowerCase());
  const h = host.toLowerCase();
  for (const url of [`https://${h}/`, `http://${h}/`]) if (usable.includes(url)) return { siteUrl: url, hostFilter: false };
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = `sc-domain:${labels.slice(i).join('.')}`;
    if (usable.includes(domain)) return { siteUrl: domain, hostFilter: true };
  }
  return null;
}

export interface ApiRow { keys?: string[]; clicks?: number; impressions?: number }
export interface WeekRow { host: string; week: string; clicks: number; impressions: number }

/** Daily rows (dimension `date`) summed into Monday-keyed weeks. */
export function weekly(host: string, rows: ApiRow[]): WeekRow[] {
  const weeks = new Map<string, WeekRow>();
  for (const r of rows) {
    const day = r.keys?.[0];
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const week = weekKey(day), row = weeks.get(week) ?? { host, week, clicks: 0, impressions: 0 };
    row.clicks += Math.max(0, Math.round(r.clicks ?? 0)); row.impressions += Math.max(0, Math.round(r.impressions ?? 0));
    weeks.set(week, row);
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** The request body for one host: daily rows over [start, end], filtered to the host on domain properties. */
export function queryBody(host: string, property: Property, start: string, end: string) {
  return {
    startDate: start, endDate: end, dimensions: ['date'], rowLimit: 25000, dataState: 'final',
    ...(property.hostFilter ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: `^https?://${host.replace(/\./g, '\\.')}(/|$)` }] }] } : {}),
  };
}
