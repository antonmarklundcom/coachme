import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOrder, closestToMoney, deterministicReason, pickToday, rankToday, ranked, score, type Candidate } from '../src/rank/today.js';
import type { TaskRow } from '../src/tasks/store.js';
import { addManualTask } from '../src/tasks/store.js';
import { buildPrompt, slug } from '../src/prompts/build.js';
import { ask, cost, startOfDay, type AiDeps, type MessagesLike } from '../src/ai/client.js';
import { buildToday } from '../src/today/service.js';
import { createApp } from '../src/web/server.js';
import { addInbox } from '../src/web/today.js';
import { loadPortfolio } from '../src/portfolio/load.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import * as z from 'zod/v4';
import { config, fixture, testDb, tempDir } from './helpers.js';

const now = new Date('2026-09-26T12:00:00Z');
let nextId = 1;
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: nextId++, project_id: 'p', title: 'Do the thing', source_kind: 'known-issue', source_file: 'KNOWN-ISSUES.md', source_line: 3, source_hash: null,
  status: 'open', money_impact: null, closeness: null, effort_h: null, pinned: 0, created_at: now.toISOString(), done_at: null,
  repo: 'r', local_path: 'C:\\Claude 1\\r', detail: null, updated_at: null, ...over,
});
const project = (id: string, stage = 'live', money_weight = 3) => ({ id, name: id, stage, money_weight });
const cand = (t: TaskRow, p = project(t.project_id ?? 'p'), over: Partial<Candidate> = {}): Candidate => ({ task: t, project: p, redAlert: false, lastActivity: 0, ...over });

describe('ranking', () => {
  it('scores money × closeness ÷ effort with a red-alert boost', () => {
    const r = score(cand(task({ closeness: 0.5, effort_h: 2 }), project('p', 'live', 4)));
    expect(r.money).toBeCloseTo(3.6); expect(r.score).toBeCloseTo(0.9);
    expect(score(cand(task({ closeness: 0.5, effort_h: 2 }), project('p', 'live', 4), { redAlert: true })).score).toBeCloseTo(1.35);
  });

  it('keeps the v3 invariant: inside one stage nearly-done beats barely-started, and a live project beats a building one', () => {
    const near = cand(task({ closeness: 0.9 }), project('a', 'building')), far = cand(task({ closeness: 0.2 }), project('b', 'building'));
    expect(ranked([far, near])[0]).toMatchObject({ task: near.task });
    const live = cand(task({ closeness: 0.5 }), project('c', 'live')), building = cand(task({ closeness: 0.9 }), project('d', 'building'));
    expect(ranked([building, live])[0].task).toBe(live.task);
  });

  it('excludes paused, killed and closed work', () => {
    const list = rankToday([cand(task(), project('x', 'paused')), cand(task(), project('y', 'killed')), cand(task({ status: 'done' })), cand(task())]);
    expect(list).toHaveLength(1);
  });

  it('takes at most 2 of the 3 from one project and gives pinned tasks a slot', () => {
    const big = project('big', 'earning', 5), small = project('small', 'planned', 1);
    const list = ranked([cand(task(), big), cand(task(), big), cand(task(), big), cand(task(), small), cand(task({ pinned: 1 }), project('pin', 'idea', 1))]);
    const picked = pickToday(list);
    expect(picked.map(r => r.project?.id)).toEqual(['pin', 'big', 'big']);
    expect(pickToday(ranked([cand(task(), big), cand(task(), big), cand(task(), big), cand(task(), small)])).map(r => r.project?.id)).toEqual(['big', 'big', 'small']);
  });

  it('breaks ties by the most recently active project', () => {
    const a = cand(task(), project('a'), { lastActivity: 1 }), b = cand(task(), project('b'), { lastActivity: 5 });
    expect(ranked([a, b])[0].project?.id).toBe('b');
  });

  it('rejects an AI order naming a task outside the candidates', () => {
    const list = ranked([cand(task()), cand(task()), cand(task())]);
    const ids = list.map(r => r.task.id);
    expect(applyOrder(list, [ids[2], ids[0], ids[1]])?.map(r => r.task.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(applyOrder(list, [ids[0], 9999, ids[1]])).toBeNull();
    expect(applyOrder(list, [ids[0], ids[0], ids[1]])).toBeNull();
    expect(applyOrder(list, [ids[0]])).toBeNull();
  });

  it('writes a plain deterministic reason and lists closest-to-money projects', () => {
    const r = ranked([cand(task({ source_kind: 'session', created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() }), project('p', 'live'), { redAlert: true })])[0];
    expect(deterministicReason(r, now)).toBe('live project · site has a red alert · an agent session stopped mid-task (2 days ago) · about 1 h');
    expect(closestToMoney([project('a', 'building', 5), project('b', 'earning', 2), project('c', 'paused', 5), project('d', 'live', 3)]).map(p => p.id)).toEqual(['d', 'a', 'b']);
  });
});

describe('copy prompt', () => {
  it('always carries the repo path, the header, the source and a DoD for its kind', () => {
    for (const kind of ['known-issue', 'handoff', 'plan-phase', 'todo', 'session', 'inbox', 'manual', 'alert'] as const) {
      const p = buildPrompt({ task: task({ source_kind: kind, title: 'Fix the lead form', repo: 'propia.node', local_path: 'C:\\Claude 1\\propia.node' }), githubOwner: 'antonmarklundcom', projectName: 'Propia', domains: ['propia.com.py'] });
      expect(p).toContain('Repo: C:\\Claude 1\\propia.node · github antonmarklundcom/propia.node');
      expect(p).toContain('Read AGENTS.md and CLAUDE.md');
      expect(p).toContain('Definition of done:');
      expect(p).toContain("The repo's own build and tests pass");
      expect(p).toContain('Branch: claude/fix-the-lead-form');
    }
    expect(buildPrompt({ task: task({ source_kind: 'session' }), githubOwner: 'o' })).toContain('git status, git log -5');
    expect(buildPrompt({ task: task(), githubOwner: 'o', goal: 'Polished goal.' })).toContain('Goal:\nPolished goal.');
    expect(slug('Finish: Añadir el RUC al footer!')).toBe('anadir-el-ruc-al-footer');
  });
});

describe('AI client', () => {
  const Schema = z.object({ answer: z.string() });
  const deps = (client: MessagesLike | null, cap = 0.5): AiDeps => ({ db: testDb(), config: { model: 'claude-sonnet-5', daily_usd_cap: cap, prices: { 'claude-sonnet-5': { input: 2, output: 10 } } }, timeZone: 'America/Asuncion', now: () => now, client });
  const fake = () => ({ parse: vi.fn(async () => ({ parsed_output: { answer: 'yes' }, stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } })) });

  it('prices calls, caches by input and never calls twice for the same input', async () => {
    const client = fake(), d = deps(client);
    const opts = { purpose: 'test', system: 's', input: { q: 1 }, schema: Schema, maxTokens: 100 };
    expect(await ask(d, opts)).toEqual({ answer: 'yes' });
    expect(await ask(d, opts)).toEqual({ answer: 'yes' });
    expect(client.parse).toHaveBeenCalledOnce();
    expect((d.db.prepare('SELECT usd FROM ai_calls').get() as { usd: number }).usd).toBeCloseTo(0.004);
    expect(cost(d.config, 'claude-sonnet-5', 1_000_000, 0)).toBe(2);
  });

  it('refuses once the daily cap is reached and returns null without a key', async () => {
    const client = fake(), d = deps(client, 0.001);
    d.db.prepare("INSERT INTO ai_calls(at,purpose,model,in_tok,out_tok,usd) VALUES (?,?,?,0,0,0.002)").run(now.toISOString(), 'x', 'claude-sonnet-5');
    expect(await ask(d, { purpose: 'test', system: 's', input: { q: 2 }, schema: Schema, maxTokens: 100 })).toBeNull();
    expect(client.parse).not.toHaveBeenCalled();
    expect(await ask(deps(null), { purpose: 'test', system: 's', input: { q: 3 }, schema: Schema, maxTokens: 100 })).toBeNull();
  });

  it('treats refusals and invalid output as no answer', async () => {
    const refusal = { parse: vi.fn(async () => ({ parsed_output: null, stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } })) };
    expect(await ask(deps(refusal), { purpose: 't', system: 's', input: {}, schema: Schema, maxTokens: 10 })).toBeNull();
    const failing = { parse: vi.fn(async () => { throw new Error('network'); }) };
    expect(await ask(deps(failing), { purpose: 't', system: 's', input: {}, schema: Schema, maxTokens: 10 })).toBeNull();
  });

  it('counts the day in the owner timezone', () => {
    expect(startOfDay(new Date('2026-09-26T02:00:00Z'), 'America/Asuncion')).toBe('2026-09-25T03:00:00.000Z');
  });
});

describe('Today service and pages', () => {
  function setup(aiClient: MessagesLike | null = null) {
    const db = testDb(), portfolioPath = join(tempDir(), 'portfolio.yaml');
    writeFileSync(portfolioPath, fixture('portfolio.yaml'));
    syncPortfolio(db, loadPortfolio(fixture('portfolio.yaml')));
    const app = createApp({ db, config, portfolioPath, collectors: [{ name: 'github', intervalMin: 30 }], now: () => now, aiClient });
    return { db, app, portfolioPath };
  }

  it('shows at most 3 actions with copy buttons and an AI-off footer', async () => {
    const { db, app } = setup();
    for (let i = 0; i < 5; i++) addManualTask(db, { project_id: 'propia', title: `Task ${i}` }, now);
    const html = await (await app.request('/')).text();
    expect(html.match(/data-copy=/g)).toHaveLength(2); // per-project cap: 2 from propia, nothing else open
    expect(html).toContain('AI off');
    expect(html).toContain('Closest to money');
  });

  it('uses a valid AI order and reason, and falls back when the AI invents an id', async () => {
    // Each case gets its own database: the same input would otherwise hit the AI cache.
    const deps = (orderOf: (ids: number[]) => number[]) => {
      const { db } = setup();
      const ids = [1, 2, 3].map(i => addManualTask(db, { project_id: null, title: `T${i}` }, now));
      return { ids, deps: depsFor(db, orderOf(ids)) };
    };
    const depsFor = (db: ReturnType<typeof testDb>, order: number[]) => ({ db, githubOwner: 'o', timeZone: 'America/Asuncion', now: () => now,
      ai: { db, config: config.ai, timeZone: 'America/Asuncion', now: () => now, client: { parse: vi.fn(async (p: Record<string, unknown>) => ({ parsed_output: String(p.system).includes('rank') ? { order: order.map(id => ({ id, reason: `because ${id}` })) } : null, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })) } } });
    const g = deps(ids => [ids[2], ids[0], ids[1]]);
    const good = await buildToday(g.deps);
    expect(good.actions.map(a => a.task.id)).toEqual([g.ids[2], g.ids[0], g.ids[1]]);
    expect(good.actions[0].reason).toBe(`because ${g.ids[2]}`);
    const bad = await buildToday(deps(ids => [ids[2], 999, ids[1]]).deps);
    expect(bad.actions.every(a => !a.aiReason)).toBe(true);
  });

  it('persists done, drop, pin and effort, and keeps the redirect on this site', async () => {
    const { db, app } = setup();
    const id = addManualTask(db, { project_id: 'propia', title: 'Ship it' }, now);
    const post = (path: string, body: Record<string, string> = {}) => app.request(path, { method: 'POST', body: new URLSearchParams(body) });
    expect((await post(`/task/${id}/pin`, { back: '//evil.test' })).headers.get('location')).toBe('/');
    expect(db.prepare('SELECT pinned FROM tasks WHERE id=?').get(id)).toEqual({ pinned: 1 });
    expect((await post(`/task/${id}/effort`, { hours: '0' })).status).toBe(400);
    await post(`/task/${id}/effort`, { hours: '3', back: '/tasks' });
    await post(`/task/${id}/done`);
    expect(db.prepare('SELECT status, effort_h FROM tasks WHERE id=?').get(id)).toEqual({ status: 'done', effort_h: 3 });
    expect((await post('/task/9999/done')).status).toBe(404);
  });

  it('captures to the inbox from the UI and the CLI helper, and triages to task, idea or drop', async () => {
    const { db, app } = setup();
    await app.request('/inbox', { method: 'POST', body: new URLSearchParams({ text: 'Call the propia client' }) });
    addInbox(db, 'New app idea', 'cli', now);
    addInbox(db, 'noise', 'cli', now);
    const [a, b, c] = (db.prepare('SELECT id, source FROM inbox ORDER BY id').all() as { id: number; source: string }[]);
    expect([a.source, b.source]).toEqual(['ui', 'cli']);
    expect((await (await app.request('/inbox')).text())).toContain('Call the propia client');
    await app.request(`/inbox/${a.id}/task`, { method: 'POST', body: new URLSearchParams({ project_id: 'propia' }) });
    await app.request(`/inbox/${b.id}/idea`, { method: 'POST' });
    await app.request(`/inbox/${c.id}/drop`, { method: 'POST' });
    expect(db.prepare("SELECT title, source_kind, project_id FROM tasks").get()).toEqual({ title: 'Call the propia client', source_kind: 'inbox', project_id: 'propia' });
    expect(db.prepare("SELECT text FROM ideas").get()).toEqual({ text: 'New app idea' });
    expect(db.prepare('SELECT count(*) AS n FROM inbox WHERE triaged_as IS NULL').get()).toEqual({ n: 0 });
    expect((await app.request('/ideas')).status).toBe(200);
    expect((await (await app.request('/project/propia')).text())).toContain('Call the propia client');
  });

  it('escapes task text in the page and in the prompt textarea', async () => {
    const { db, app } = setup();
    addManualTask(db, { project_id: 'propia', title: '<script>alert(1)</script>' }, now);
    const html = await (await app.request('/')).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(readFileSync(join(process.cwd(), 'src/web/today.tsx'), 'utf8')).not.toMatch(/dangerouslySetInnerHTML=\{\{ __html: (?!copyScript)/);
  });
});
