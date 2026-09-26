import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/web/server.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { addManualTask } from '../src/tasks/store.js';
import { createTelegram, escapeHtml, splitMessage, type FetchLike } from '../src/notify/telegram.js';
import { handleUpdate, startBot } from '../src/notify/bot.js';
import { dailyDue, pushAlerts, weeklyDue, todayMessage, getKv } from '../src/notify/rules.js';
import { rhythmTick, type RhythmDeps } from '../src/notify/rhythm.js';
import { weeklyFacts, sections } from '../src/review/weekly.js';
import { transition } from '../src/alerts/index.js';
import type { Portfolio } from '../src/portfolio/schema.js';
import { config, fixture, testDb, tempDir } from './helpers.js';

const TZ = 'America/Asuncion';
// Sunday 2026-09-27 18:30 in Asunción (UTC-3).
const sunday = new Date('2026-09-27T21:30:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function portfolio(): Portfolio {
  const p = loadPortfolio(fixture('portfolio.yaml'));
  const base = p.projects[0];
  p.projects.push(
    { ...base, id: 'shop', name: 'Shop', stage: 'earning', repos: ['shop'], domains: [] },
    { ...base, id: 'old', name: 'Old', stage: 'building', money: { model: 'x', weight: 3 }, repos: ['old'], domains: [] },
    { ...base, id: 'dead', name: 'Dead', stage: 'deployed', money: { model: 'x', weight: 1 }, repos: ['dead'], domains: [] },
  );
  return p;
}
function rhythmDeps(db: ReturnType<typeof testDb>, now: Date, send: RhythmDeps['send']): RhythmDeps {
  const ai = { db, config: config.ai, timeZone: TZ, now: () => now, log, client: null };
  return { db, ai, today: { db, ai, githubOwner: 'antonmarklundcom', timeZone: TZ, now: () => now }, timeZone: TZ, notify: config.notify, now: () => now, log, send };
}

describe('telegram client', () => {
  it('escapes HTML, cuts at 4000 characters on line breaks, and checks the ok field without leaking the token', async () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const parts = splitMessage(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(p => p.length <= 4000)).toBe(true);
    expect(parts.join('\n')).toBe(long);
    const token = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';
    const bodies: unknown[] = [];
    const ok: FetchLike = async (_url, init) => { bodies.push(JSON.parse(init!.body!)); return { json: async () => ({ ok: true, result: [] }) }; };
    await createTelegram(token, ok).send('42', long);
    expect(bodies).toHaveLength(parts.length);
    expect(bodies[0]).toMatchObject({ chat_id: '42', parse_mode: 'HTML' });
    const refused: FetchLike = async () => ({ json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
    await expect(createTelegram(token, refused).send('42', 'hi')).rejects.toThrow('chat not found');
    const broken: FetchLike = async url => { throw new Error(`connect failed ${url}`); };
    const error = await createTelegram(token, broken).send('42', 'hi').catch(e => e as Error);
    expect(error.message).not.toContain(token);
  });
});

describe('bot', () => {
  const update = (chat: number | string, text: string, id = 1) => ({ update_id: id, message: { chat: { id: chat }, text } });

  it('ignores other chat ids without replying or writing', async () => {
    const db = testDb(), today = vi.fn(async () => 'today');
    const deps = { db, chatId: '111', now: () => sunday, today };
    expect(await handleUpdate(deps, update(222, 'buy domain'))).toBeNull();
    expect(await handleUpdate(deps, update(222, '/today'))).toBeNull();
    expect(await handleUpdate(deps, update(222, '/idea world domination'))).toBeNull();
    expect(await handleUpdate(deps, { update_id: 3 })).toBeNull();
    expect(today).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM inbox').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM ideas').get()).toEqual({ n: 0 });
  });

  it('sends plain text to the inbox, /idea to ideas and answers /today', async () => {
    const db = testDb(), today = vi.fn(async () => 'the 3 things');
    const deps = { db, chatId: '111', now: () => sunday, today };
    expect(await handleUpdate(deps, update(111, 'call the propia client'))).toBe('In the inbox.');
    expect(await handleUpdate(deps, update(111, '/idea a padel booking site'))).toBe('Parked on /ideas.');
    expect(await handleUpdate(deps, update(111, '/today@coachme_bot'))).toBe('the 3 things');
    expect(await handleUpdate(deps, update(111, '/idea'))).toContain('Usage');
    expect(await handleUpdate(deps, update(111, '/help'))).toContain('/today');
    expect(db.prepare('SELECT text, source FROM inbox').all()).toEqual([{ text: 'call the propia client', source: 'telegram' }]);
    expect(db.prepare('SELECT text, status FROM ideas').all()).toEqual([{ text: 'a padel booking site', status: 'parked' }]);
  });

  it('long-polls, replies only to the allowed chat, and stores the offset', async () => {
    const db = testDb(), sent: [string, string][] = [];
    let calls = 0;
    const telegram = {
      send: async (chat: string, html: string) => { sent.push([chat, html]); },
      getUpdates: vi.fn(async (offset: number) => {
        calls++;
        if (calls === 1) { expect(offset).toBe(0); return [update(999, 'spam', 5), update(111, 'real', 6)]; }
        expect(offset).toBe(7);
        await new Promise(r => setTimeout(r, 5));
        return [];
      }),
    };
    const bot = startBot({ db, chatId: '111', now: () => sunday, today: async () => '', telegram, log });
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1));
    await bot.stop();
    expect(sent).toEqual([['111', 'In the inbox.']]);
    expect(getKv(db, 'telegram_offset')).toBe('7');
  });
});

describe('pushes', () => {
  it('pushes a red alert exactly once when it opens and once when it closes; amber stays quiet', async () => {
    const db = testDb(), send = vi.fn(async (_html: string) => {});
    const t0 = new Date('2026-09-26T12:00:00Z'), t1 = new Date('2026-09-26T13:00:00Z');
    transition(db, 'domain:propia.com.py', [{ kind: 'down', severity: 'red' }], t0.toISOString());
    transition(db, 'hosting:a', [{ kind: 'next_build', severity: 'amber' }], t0.toISOString());
    expect(await pushAlerts(db, send, t0)).toBe(1);
    expect(await pushAlerts(db, send, t0)).toBe(0);
    transition(db, 'domain:propia.com.py', [{ kind: 'down', severity: 'red' }], t0.toISOString());
    expect(await pushAlerts(db, send, t0)).toBe(0);
    transition(db, 'domain:propia.com.py', [], t1.toISOString());
    transition(db, 'hosting:a', [], t1.toISOString());
    expect(await pushAlerts(db, send, t1)).toBe(1);
    expect(await pushAlerts(db, send, t1)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toContain('Broken');
    expect(send.mock.calls[1][0]).toContain('Fixed');
    expect(send.mock.calls[1][0]).toContain('propia.com.py');
  });

  it('retries an alert push that failed and never marks it before it went out', async () => {
    const db = testDb();
    transition(db, 'domain:a.com', [{ kind: 'down', severity: 'red' }], sunday.toISOString());
    await expect(pushAlerts(db, async () => { throw new Error('offline'); }, sunday)).rejects.toThrow('offline');
    expect(db.prepare('SELECT notified_at FROM alerts').get()).toEqual({ notified_at: null });
    const send = vi.fn(async () => {});
    await pushAlerts(db, send, sunday);
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips the daily push on an empty day and sends once a day otherwise', async () => {
    const at = (iso: string) => new Date(iso);
    expect(dailyDue(at('2026-09-26T10:59:00Z'), TZ, '08:00')).toBeNull(); // 07:59 local
    expect(dailyDue(at('2026-09-26T11:00:00Z'), TZ, '08:00')).toBe('2026-09-26');
    expect(todayMessage([], { actions: [] })).toBeNull();

    const db = testDb(), send = vi.fn(async (_html: string) => {});
    syncPortfolio(db, portfolio());
    const morning = at('2026-09-26T11:05:00Z');
    await rhythmTick(rhythmDeps(db, morning, send));
    expect(send.mock.calls.filter(c => c[0].includes('Your 3 things'))).toHaveLength(0);
    expect(getKv(db, 'daily_push')).toBe('2026-09-26');

    const next = at('2026-09-27T11:05:00Z');
    addManualTask(db, { project_id: 'shop', title: 'Send the <invoice>' }, next);
    await rhythmTick(rhythmDeps(db, next, send));
    await rhythmTick(rhythmDeps(db, at('2026-09-27T15:00:00Z'), send));
    const daily = send.mock.calls.filter(c => c[0].includes('Your 3 things'));
    expect(daily).toHaveLength(1);
    expect(daily[0][0]).toContain('Send the &lt;invoice&gt;');
  });
});

describe('weekly review', () => {
  function week() {
    const db = testDb(), p = portfolio();
    const early = new Date('2026-09-10T12:00:00Z');
    syncPortfolio(db, p, early.toISOString());
    // Stage raise during the week: building → live.
    p.projects[0] = { ...p.projects[0], stage: 'live' };
    syncPortfolio(db, p, '2026-09-24T12:00:00.000Z');
    const snap = db.prepare("INSERT INTO gh_snapshots(repo,at,last_commit_at,open_prs,default_ci,stale_branches) VALUES (?,?,?,'[]','green','[]')");
    snap.run('propia.node', '2026-09-27T12:00:00Z', '2026-09-26T12:00:00Z');
    snap.run('shop', '2026-09-27T12:00:00Z', '2026-09-20T12:00:00Z');
    snap.run('old', '2026-09-27T12:00:00Z', '2026-09-07T12:00:00Z');
    snap.run('dead', '2026-09-27T12:00:00Z', '2026-08-10T12:00:00Z');
    const deploy = db.prepare('INSERT INTO deploys(repo,at,sha,pr_number,source) VALUES (?,?,?,?,?)');
    deploy.run('propia.node', '2026-09-25T12:00:00Z', 'a1', 12, 'merged PR');
    deploy.run('propia.node', '2026-09-26T12:00:00Z', 'b2', null, 'push to default branch');
    deploy.run('shop', '2026-09-01T12:00:00Z', 'c3', 3, 'merged PR'); // outside the week
    const task = addManualTask(db, { project_id: 'propia', title: 'Wire the lead form' }, early);
    db.prepare("UPDATE tasks SET status='done', done_at='2026-09-26T15:00:00Z' WHERE id=?").run(task);
    transition(db, 'domain:propia.com.py', [{ kind: 'down', severity: 'red' }], '2026-09-25T09:00:00Z');
    transition(db, 'domain:propia.com.py', [], '2026-09-25T10:00:00Z');
    db.prepare("INSERT INTO revenue(project_id,client,amount,currency,recurring,date) VALUES ('shop','Acme',1500000,'PYG','monthly','2026-09-26')").run();
    db.prepare("INSERT INTO revenue(project_id,client,amount,currency,recurring,date) VALUES ('shop','Old',99,'USD','none','2026-08-01')").run();
    db.prepare("INSERT INTO crm_leads_daily(crm_site,day,leads,source) VALUES ('propia','2026-09-25',4,'fixture'),('propia','2026-09-01',9,'fixture')").run();
    return db;
  }

  it('covers every section from a fixture week', () => {
    const db = week(), f = weeklyFacts(db, sunday, TZ);
    expect(f.week).toBe('2026-09-21');
    expect(f.shipped.deploys).toEqual([{ repo: 'propia.node', merged_prs: [12], pushes: 1 }]);
    expect(f.shipped.stage_raises).toMatchObject([{ project_id: 'propia', from: 'building', to: 'live' }]);
    expect(f.shipped.tasks_done).toEqual([{ title: 'Wire the lead form', project: 'Propia' }]);
    expect(f.broke.alerts).toHaveLength(1);
    expect(f.broke.alerts[0]).toMatchObject({ severity: 'red', closed_at: '2026-09-25T10:00:00Z' });
    expect(f.earned.revenue).toEqual([{ project: 'Shop', client: 'Acme', amount: 1500000, currency: 'PYG', date: '2026-09-26' }]);
    expect(f.earned.totals).toEqual([{ currency: 'PYG', amount: 1500000 }]);
    expect(f.earned.leads_total).toBe(4);
    expect(f.earned.leads).toEqual([{ project: 'Propia', leads: 4 }]);
    expect(f.stalled.map(s => [s.project_id, s.days])).toEqual([['dead', 48], ['old', 20]]);
    expect(f.kills.map(k => k.project_id)).toEqual(['dead']);
    const text = sections(f).map(s => `${s.title}\n${s.lines.join('\n')}`).join('\n');
    for (const piece of ['merged #12', 'Propia moved up: building → live', 'fixed', '1,500,000 PYG', 'Leads: 4', 'Old (building): 20 days quiet', 'Dead (deployed, weight 1)']) expect(text).toContain(piece);
  });

  it('is generated, stored and sent on Sunday at 18:00, once', async () => {
    const db = week(), send = vi.fn(async (_html: string) => {});
    expect(weeklyDue(new Date('2026-09-27T20:59:00Z'), TZ, 0, '18:00')).toBe('2026-09-14'); // 17:59: still last week
    expect(weeklyDue(sunday, TZ, 0, '18:00')).toBe('2026-09-21');
    await rhythmTick(rhythmDeps(db, sunday, send));
    await rhythmTick(rhythmDeps(db, new Date(sunday.getTime() + 60_000), send));
    const reviews = db.prepare('SELECT week, headline, sent_at, ai FROM reviews').all() as { week: string; headline: string; sent_at: string | null; ai: number }[];
    expect(reviews.find(r => r.week === '2026-09-21')).toMatchObject({ sent_at: sunday.toISOString(), ai: 0 });
    const weekly = send.mock.calls.map(c => c[0]).filter(m => m.includes('Weekly review') && m.includes('2026-09-21'));
    expect(weekly).toHaveLength(1);
    for (const title of ['Shipped', 'Broke', 'Earned', 'Stalled 14+ days', 'Suggested kills']) expect(weekly[0]).toContain(`<b>${title}</b>`);
  });

  it('shows on /review with one-tap pause or kill for suggested kills, plus the archive', async () => {
    const db = week(), path = join(tempDir(), 'portfolio.yaml');
    writeFileSync(path, fixture('portfolio.yaml'));
    const app = createApp({ db, config, portfolioPath: path, collectors: [], now: () => sunday, aiClient: null });
    expect(await (await app.request('/review')).text()).toContain('No weekly review yet');
    expect((await app.request('/review/generate', { method: 'POST' })).status).toBe(303);
    const html = await (await app.request('/review')).text();
    expect(html).toContain('data-section="Suggested kills"');
    expect(html).toContain('action="/project/dead/pause"');
    expect(html).toContain('/review?week=2026-09-21');
    expect((await app.request('/review?week=2026-09-21')).status).toBe(200);
    expect((await app.request('/review?week=1999-01-04')).status).toBe(404);
  });
});

describe('idea gate', () => {
  function setup(live = true) {
    const db = testDb(), path = join(tempDir(), 'portfolio.yaml');
    const yaml = fixture('portfolio.yaml').replace('stage: building', live ? 'stage: live' : 'stage: building')
      .replace('unassigned:', '  - id: side\n    name: Side\n    stage: building\n    money: { model: ads, weight: 2 }\n    repos: [side]\n    domains: []\nunassigned:');
    writeFileSync(path, yaml); syncPortfolio(db, loadPortfolio(yaml));
    const app = createApp({ db, config, portfolioPath: path, collectors: [], now: () => sunday, aiClient: null });
    const id = Number(db.prepare("INSERT INTO ideas(text,created_at,status) VALUES ('Padel booking','2026-09-20','parked')").run().lastInsertRowid);
    const promote = (body: Record<string, string>) => app.request(`/ideas/${id}/promote`, { method: 'POST', body: new URLSearchParams(body) });
    return { db, app, path, id, yaml, promote };
  }

  it('cannot skip the gate: a missing or wrong answer changes nothing', async () => {
    const { db, path, yaml, promote, id } = setup();
    for (const body of [{ name: 'Padel' }, { name: 'Padel', more_valuable_than: 'propia' }, { name: 'Padel', pause_project: 'side' },
      { name: 'Padel', more_valuable_than: 'side', pause_project: 'side' }, { name: 'Padel', more_valuable_than: 'propia', pause_project: 'nope' }]) {
      expect((await promote(body)).status).toBe(400);
    }
    expect(readFileSync(path, 'utf8')).toBe(yaml);
    expect(db.prepare('SELECT status FROM ideas WHERE id=?').get(id)).toEqual({ status: 'parked' });
    expect(db.prepare("SELECT stage FROM projects WHERE id='side'").get()).toEqual({ stage: 'building' });
  });

  it('promotes with both answers stored and pauses the named project in the same action', async () => {
    const { db, app, path, promote, id } = setup();
    expect(await (await app.request(`/ideas/${id}/promote`)).text()).toContain('Which live project is this more valuable than?');
    const res = await promote({ name: 'Padel booking', more_valuable_than: 'propia', pause_project: 'side', weight: '3' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/project/padel-booking');
    expect(db.prepare('SELECT status, gate_more_valuable_than, gate_pause_project FROM ideas WHERE id=?').get(id)).toEqual({ status: 'promoted', gate_more_valuable_than: 'propia', gate_pause_project: 'side' });
    expect(db.prepare("SELECT stage, stage_before, status_note FROM projects WHERE id='side'").get()).toEqual({ stage: 'paused', stage_before: 'building', status_note: 'Paused for idea: Padel booking' });
    expect(db.prepare("SELECT stage, money_weight FROM projects WHERE id='padel-booking'").get()).toEqual({ stage: 'planned', money_weight: 3 });
    const yaml = readFileSync(path, 'utf8');
    expect(yaml).toContain('# Keep this comment');
    expect(loadPortfolio(yaml).projects.find(p => p.id === 'side')?.stage).toBe('paused');
    expect((await promote({ name: 'again', more_valuable_than: 'propia', pause_project: 'propia' })).status).toBe(404);
  });

  it('says so when no project is live yet', async () => {
    const { app, id } = setup(false);
    expect(await (await app.request(`/ideas/${id}/promote`)).text()).toContain('nothing this idea can beat');
  });
});
