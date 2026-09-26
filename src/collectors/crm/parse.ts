/**
 * VenderCRM lead counting. Two read-only sources:
 *  - the counts-only stats endpoint (docs/specs/vendercrm-stats-endpoint.md), once it exists;
 *  - until then, a tenant's contacts CSV feed (/api/exports/contacts?token=…). That feed also
 *    carries names, phones and emails: only the `origen` and `creado` columns are ever read,
 *    and nothing but per-source per-day counts leaves this module.
 */

/** RFC 4180 CSV rows. Handles quotes, doubled quotes and newlines inside quoted cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export interface LeadCount { source: string; day: string; leads: number }

/** Owner-timezone calendar day of an instant. */
export const localDay = (iso: string, timeZone: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(t)) : null;
};

/**
 * Count contacts per source per day from the contacts CSV, keeping days on or after `since`.
 * Throws when the expected columns are missing so a changed export fails loudly, not silently.
 */
export function countLeadsFromCsv(csv: string, timeZone: string, since: string): LeadCount[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const names = header.map(h => h.trim().toLowerCase());
  const src = names.findIndex(n => n === 'origen' || n === 'source');
  const created = names.findIndex(n => n === 'creado' || n === 'created' || n === 'createdat' || n === 'created_at');
  if (src < 0 || created < 0) throw new Error('VenderCRM contacts feed has no origen/creado columns');
  const counts = new Map<string, number>();
  for (const r of rows) {
    const day = localDay(r[created] ?? '', timeZone);
    if (!day || day < since) continue;
    const source = normalizeSource(r[src] ?? '');
    const key = `${source}\u0000${day}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, leads]) => { const [source, day] = k.split('\u0000'); return { source, day, leads }; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source));
}

/** Counts from the stats endpoint: [{ site_slug, day, count }]. Validated, nothing else kept. */
export function countLeadsFromStats(json: unknown): LeadCount[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
  if (!list) throw new Error('VenderCRM stats endpoint returned an unexpected shape');
  return list.flatMap(item => {
    const o = item as Record<string, unknown>;
    const day = typeof o.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.day) ? o.day : null;
    const leads = Number(o.count ?? o.leads);
    if (!day || !Number.isInteger(leads) || leads < 0) return [];
    return [{ source: normalizeSource(String(o.site_slug ?? o.source ?? '')), day, leads }];
  });
}

/** A source label as stored: lowercased, protocol and www stripped, blank means unknown. */
export function normalizeSource(value: string): string {
  const v = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return v || 'unknown';
}

/** Keys that tie a domain to CRM source labels: its crm_site, its host, and the host's first label. */
export function crmKeys(host: string, crmSite: string | null): string[] {
  const h = normalizeSource(host);
  return [...new Set([crmSite ? normalizeSource(crmSite) : null, h, h.split('.')[0]].filter((k): k is string => !!k && k !== 'unknown'))];
}
