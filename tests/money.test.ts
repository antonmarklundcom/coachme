import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countLeadsFromCsv, countLeadsFromStats, crmKeys, normalizeSource, parseCsv } from '../src/collectors/crm/parse.js';
import { crmCollector, crmSettings, ensureSpecTask } from '../src/collectors/crm/index.js';
import { convert, goalValue, leadsSignal, moneySummary, suggestEarning, type GoalRow } from '../src/money/index.js';
import { createApp } from '../src/web/server.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { config, fixture, testDb, tempDir } from './helpers.js';

const now = new Date('2026-09-26T15:00:00Z');
const TZ = 'America/Asuncion';
const PII = ['Juana Pérez', '+595981000111', 'juana@example.test', 'llamar a la tarde'];
const csv = [
  'nombre,telefono,email,origen,etiquetas,responsable,notas,creado',
  `"${PII[0]}",${PII[1]},${PII[2]},propia.com.py,web,Anton,"${PII[3]}, urgente",2026-09-25T14:00:00.000Z`,
  '"Pedro ""Pepe"" Gómez",+595981000222,,https://www.propia.com.py/contacto,,,"línea 1\nlínea 2",2026-09-25T20:00:00.000Z',
  'Ana,+595981000333,,tasacion.com.py,,,,2026-09-26T02:30:00.000Z',
  'Old,+595981000444,,propia.com.py,,,,2026-06-01T12:00:00.000Z',
  'Nadie,+595981000555,,,,,,2026-09-26T12:00:00.000Z',
].join('\r\n');

describe('VenderCRM parsing', () => {
  it('parses quoted cells, doubled quotes and newlines inside cells', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
  });

  it('counts leads per source per owner-timezone day and keeps nothing personal', () => {
    const counts = countLeadsFromCsv(csv, TZ, '2026-09-01');
    expect(counts).toEqual([
      { source: 'propia.com.py', day: '2026-09-25', leads: 2 },
      { source: 'tasacion.com.py', day: '2026-09-25', leads: 1 }, // 02:30Z is still the 25th in Asunción
      { source: 'unknown', day: '2026-09-26', leads: 1 },
    ]);
    const out = JSON.stringify(counts);
    for (const p of PII) expect(out).not.toContain(p);
    expect(() => countLeadsFromCsv('nombre,telefono\nx,y', TZ, '2026-01-01')).toThrow(/origen/);
  });

  it('validates the stats endpoint shape and keeps counts only', () => {
    expect(countLeadsFromStats({ data: [{ tenant_slug: 't', site_slug: 'Propia.com.py', day: '2026-09-25', count: 4 }, { day: 'bad', count: 1 }, { site_slug: 'x', day: '2026-09-25', count: -1 }] }))
      .toEqual([{ source: 'propia.com.py', day: '2026-09-25', leads: 4 }]);
    expect(() => countLeadsFromStats({ nope: true })).toThrow();
  });

  it('normalizes sources and derives CRM keys from a domain', () => {
    expect(normalizeSource(' https://www.Propia.com.py/contacto ')).toBe('propia.com.py');
    expect(crmKeys('propia.com.py', 'propia')).toEqual(['propia', 'propia.com.py']);
  });
});

describe('crm collector', () => {
  const ctx = (db = testDb()) => ({ db, config, exec: vi.fn(), now: () => now, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const TOKEN = 'feedtoken' + 'x'.repeat(24);

  it('reads settings from the environment without exposing them', () => {
    expect(crmSettings({ VENDERCRM_FEED_TOKENS: `main=${TOKEN}, second=abc` } as NodeJS.ProcessEnv)).toEqual({ baseUrl: 'https://crm.clientes.com.py', statsKey: null, feeds: [{ label: 'main', token: TOKEN }, { label: 'second', token: 'abc' }] });
  });

  it('counts the feed, stores per-day totals and never stores the CSV', async () => {
    const c = ctx();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => csv }));
    const n = await crmCollector(60, () => ({ baseUrl: 'https://crm.test', statsKey: null, feeds: [{ label: 'main', token: TOKEN }] }), fetch).run(c);
    expect(n).toBe(3);
    expect(fetch.mock.calls[0][0]).toBe(`https://crm.test/api/exports/contacts?token=${TOKEN}`);
    const stored = JSON.stringify(c.db.prepare('SELECT * FROM crm_leads_daily').all());
    for (const p of PII) expect(stored).not.toContain(p);
    expect(c.db.prepare("SELECT leads FROM crm_leads_daily WHERE crm_site='propia.com.py'").get()).toEqual({ leads: 2 });
  });

  it('prefers the stats endpoint when a key is set and keeps the token out of errors', async () => {
    const c = ctx();
    const stats = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ site_slug: 'propia.com.py', day: '2026-09-25', count: 7 }] }) }));
    await crmCollector(60, () => ({ baseUrl: 'https://crm.test', statsKey: 'k', feeds: [] }), stats).run(c);
    expect(stats.mock.calls[0][0]).toMatch(/\/api\/ops\/v1\/stats\/leads\?from=\d{4}-\d{2}-\d{2}&to=2026-09-26$/);
    expect(c.db.prepare('SELECT leads, source FROM crm_leads_daily').get()).toEqual({ leads: 7, source: 'stats' });
    const failing = vi.fn(async (url: string) => { throw new Error(`boom ${url}`); });
    await expect(crmCollector(60, () => ({ baseUrl: 'https://crm.test', statsKey: null, feeds: [{ label: 'main', token: TOKEN }] }), failing).run(c)).rejects.toThrow(/feed main/);
    await crmCollector(60, () => ({ baseUrl: 'https://crm.test', statsKey: null, feeds: [{ label: 'main', token: TOKEN }] }), failing).run(c).catch(e => expect(String(e)).not.toContain(TOKEN));
  });

  it('keeps one spec task in the vendercrm project while no stats key exists', () => {
    const db = testDb();
    expect(ensureSpecTask(db, now)).toBe(false); // no vendercrm project yet
    db.prepare("INSERT INTO projects(id,name,stage,market,kind,money_model,money_weight) VALUES ('vendercrm','vendercrm','building','PY','saas','saas',1)").run();
    expect(ensureSpecTask(db, now)).toBe(true);
    expect(ensureSpecTask(db, now)).toBe(false);
    expect(db.prepare('SELECT title, source_file FROM tasks').get()).toMatchObject({ source_file: 'coachme/docs/specs/vendercrm-stats-endpoint.md' });
  });
});

describe('money', () => {
  function seeded() {
    const db = testDb();
    db.prepare("INSERT INTO projects(id,name,stage,market,kind,money_model,money_weight) VALUES ('p','P','live','PY','saas','saas',3),('q','Q','building','SE','saas','saas',2)").run();
    db.prepare("INSERT INTO fx(currency,per_usd,set_at) VALUES ('PYG',7500,'x'),('SEK',10,'x')").run();
    const add = db.prepare('INSERT INTO revenue(project_id,client,amount,currency,recurring,date) VALUES (?,?,?,?,?,?)');
    add.run('p', 'Cliente A', 750000, 'PYG', 'monthly', '2026-08-26');
    add.run('p', 'Cliente A', 1500000, 'PYG', 'monthly', '2026-09-26'); // raise: MRR counts the latest amount once
    add.run('q', 'Kund', 1200, 'SEK', 'yearly', '2026-09-10');
    add.run('q', null, 50, 'EUR', 'none', '2026-09-12'); // EUR rate missing
    return db;
  }

  it('converts through USD and reports missing rates', () => {
    expect(convert(7500, 'PYG', 'USD', { USD: 1, PYG: 7500, SEK: 10, EUR: null })).toBe(1);
    expect(convert(1, 'EUR', 'USD', { USD: 1, PYG: 7500, SEK: 10, EUR: null })).toBeNull();
  });

  it('sums this month, last 30 days and MRR in the chosen currency', () => {
    const s = moneySummary(seeded(), 'USD', now, TZ);
    expect(s.thisMonth).toBeCloseTo(200 + 120);
    expect(s.last30).toBeCloseTo(200 + 120);
    expect(s.mrr).toBeCloseTo(200 + 10);
    expect(s.missingRates).toEqual(['EUR']);
  });

  it('computes every goal metric with its source', () => {
    const db = seeded();
    const g = (metric: GoalRow['metric'], extra: Partial<GoalRow> = {}): GoalRow => ({ id: 1, period: '2026-Q4', metric, target: 1000, unit: 'USD', manual_value: null, label: null, ...extra });
    expect(goalValue(db, g('revenue_monthly'), now, TZ).value).toBe(320);
    expect(goalValue(db, g('projects_earning'), now, TZ).value).toBe(2);
    expect(goalValue(db, g('leads_month', { manual_value: 12 }), now, TZ)).toMatchObject({ value: 12, source: expect.stringContaining('No CRM data') });
    db.prepare("INSERT INTO crm_leads_daily VALUES ('propia.com.py','2026-09-20',5,'feed'),('x','2026-08-20',9,'feed')").run();
    expect(goalValue(db, g('leads_month'), now, TZ).value).toBe(5);
    expect(goalValue(db, g('custom', { manual_value: 3 }), now, TZ).value).toBe(3);
    db.prepare("INSERT INTO domains(host,project_id) VALUES ('p.test','p'),('q.test','q')").run();
    db.prepare("INSERT INTO domain_checks(host,at,status,error_kind) VALUES ('p.test','2026-09-26',200,NULL),('q.test','2026-09-25',200,NULL),('q.test','2026-09-26',503,'HTTP_5XX')").run();
    expect(goalValue(db, g('sites_live'), now, TZ).value).toBe(1);
  });

  it('turns lead trends into a dot', () => {
    const db = seeded();
    db.prepare("INSERT INTO domains(host,project_id,crm_site) VALUES ('propia.com.py','p','propia')").run();
    expect(leadsSignal(db, 'p', now, TZ).state).toBe('grey');
    db.prepare("INSERT INTO crm_leads_daily VALUES ('propia','2026-09-15',4,'feed')").run();
    expect(leadsSignal(db, 'p', now, TZ)).toMatchObject({ state: 'red', sentence: expect.stringContaining('Leads stopped') });
    db.prepare("INSERT INTO crm_leads_daily VALUES ('propia.com.py','2026-09-24',5,'feed')").run();
    expect(leadsSignal(db, 'p', now, TZ).state).toBe('green');
  });

  it('suggests earning after recent revenue and never lowers', () => {
    const db = seeded();
    expect(suggestEarning(db, 'p', now)).toBe('earning');
    db.prepare("UPDATE projects SET stage='earning' WHERE id='p'").run();
    expect(suggestEarning(db, 'p', now)).toBeNull();
  });
});

describe('goals & money page', () => {
  function setup() {
    const db = testDb(), portfolioPath = join(tempDir(), 'portfolio.yaml');
    writeFileSync(portfolioPath, fixture('portfolio.yaml'));
    syncPortfolio(db, loadPortfolio(fixture('portfolio.yaml')));
    return { db, app: createApp({ db, config, portfolioPath, collectors: [], now: () => now, aiClient: null }) };
  }
  const post = (app: ReturnType<typeof setup>['app'], path: string, body: Record<string, string>) => app.request(path, { method: 'POST', body: new URLSearchParams(body) });

  it('adds goals, revenue and rates, validates input, and shows progress', async () => {
    const { db, app } = setup();
    expect((await post(app, '/goals', { period: 'Q4', metric: 'revenue_monthly', target: '10' })).status).toBe(400);
    expect((await post(app, '/goals', { period: '2026-Q4', metric: 'revenue_monthly', target: '1000', unit: 'USD' })).status).toBe(303);
    expect((await post(app, '/revenue', { project_id: 'propia', amount: 'abc', currency: 'PYG', recurring: 'monthly', date: '2026-09-20' })).status).toBe(400);
    expect((await post(app, '/revenue', { project_id: 'propia', client: 'Inmobiliaria X', amount: '3750000', currency: 'PYG', recurring: 'monthly', date: '2026-09-20' })).status).toBe(303);
    expect(db.prepare("SELECT stage_suggestion FROM projects WHERE id='propia'").get()).toEqual({ stage_suggestion: 'earning' });
    let html = await (await app.request('/goals')).text();
    expect(html).toContain('set exchange rates for PYG');
    expect((await post(app, '/fx', { PYG: '-1' })).status).toBe(400);
    await post(app, '/fx', { PYG: '7500', SEK: '', EUR: '' });
    html = await (await app.request('/goals')).text();
    expect(html).toContain('500 USD of 1,000 USD (50%)');
    expect(html).toContain('Inmobiliaria X');
    expect(html).toContain('No lead data yet');
    const id = (db.prepare('SELECT id FROM revenue').get() as { id: number }).id;
    await post(app, `/revenue/${id}/delete`, {});
    expect(db.prepare('SELECT count(*) AS n FROM revenue').get()).toEqual({ n: 0 });
  });
});
