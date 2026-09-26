import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { attribute, countPaths, countRelative, endedMidTask, parseSessionText, realUserText, type SessionFacts } from '../src/collectors/sessions/parse.js';
import { repoFromRemote, sessionsCollector, syncSessionTasks } from '../src/collectors/sessions/index.js';
import { config, testDb, tempDir } from './helpers.js';

// Fake secrets assembled from fragments so no real-looking token sits in the repo.
const FAKE = 'FAKEVALUEFORTESTINGONLY';
const SECRETS = [
  'sk-ant-' + FAKE, 'ghp_' + FAKE, 'github_pat_' + FAKE, 'xoxb-' + FAKE, 'AKIA' + 'Z'.repeat(16),
  'Bearer ' + FAKE, 'password=' + FAKE, 'api_key: ' + FAKE, `https://user:${FAKE}@db.test/x`, 'X'.repeat(40),
];
const ROOT = 'C:\\Claude 1';
const now = new Date('2026-09-26T12:00:00Z');
const t = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

const claudeLog = (lastRequest: string, end: 'tool' | 'text' | 'question' = 'tool') => [
  { type: 'custom-title', customTitle: 'Fix nombres 503', sessionId: 's1' },
  { type: 'user', cwd: ROOT, gitBranch: 'main', timestamp: t(300), message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' }, isMeta: true },
  { type: 'user', cwd: ROOT, gitBranch: 'main', timestamp: t(290), message: { role: 'user', content: `First ask with ${SECRETS[0]}` } },
  { type: 'assistant', cwd: ROOT, timestamp: t(280), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\Claude 1\\nombres-com-py\\index.html' } }] } },
  { type: 'user', cwd: ROOT, timestamp: t(279), message: { content: [{ type: 'tool_result', content: 'file body ' + SECRETS[1] }] } },
  { type: 'user', cwd: ROOT, timestamp: t(200), message: { role: 'user', content: [{ type: 'text', text: lastRequest }] } },
  { type: 'assistant', isSidechain: true, timestamp: t(100), message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
  end === 'tool'
    ? { type: 'assistant', cwd: ROOT, timestamp: t(190), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd "C:/Claude 1/nombres-com-py" && npm run build' } }] } }
    : { type: 'assistant', cwd: ROOT, timestamp: t(190), message: { content: [{ type: 'text', text: end === 'question' ? 'Should I deploy it now?' : 'Done, the build passes.' }] } },
].map(o => JSON.stringify(o)).join('\n');

const codexLog = [
  { timestamp: t(500), type: 'session_meta', payload: { cwd: ROOT } },
  { timestamp: t(499), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
  { timestamp: t(498), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the trabajo sitemap ' + SECRETS.slice(2).join(' ') }] } },
  { timestamp: t(497), type: 'compacted', payload: { encrypted_content: 'gAAAA' + 'q'.repeat(60) } },
  { timestamp: t(496), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'Get-Content trabajo\\src\\app\\sitemap.ts' } },
  { timestamp: t(495), type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'ok' } },
  { timestamp: t(494), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sitemap fixed and tests pass.' }] } },
].map(o => JSON.stringify(o)).join('\n');

const checkouts = [
  { path: 'C:\\Claude 1\\nombres-com-py', repo: 'nombres' },
  { path: 'C:\\Claude 1\\trabajo', repo: 'trabajo' },
  { path: 'C:\\Claude 1\\vendercrm-repo', repo: 'vendercrm' },
];
const noSecrets = (text: string) => { for (const s of [FAKE, 'Z'.repeat(16), 'X'.repeat(40)]) expect(text).not.toContain(s); };

describe('session parsing', () => {
  it('reduces a Claude log to redacted facts, ignoring meta, tool results and sidechains', () => {
    const f = parseSessionText('claude', claudeLog('Please finish the deploy of nombres'), [ROOT]);
    expect(f.title).toBe('Fix nombres 503');
    expect(f.last_request).toBe('Please finish the deploy of nombres');
    expect(f.user_turns).toBe(2);
    expect(f.tool_calls).toBe(2);
    expect(f.last_event).toBe('tool_call');
    expect(f.paths['c:\\claude 1\\nombres-com-py']).toBe(2);
    expect(f.started_at).toBe(t(300));
    noSecrets(JSON.stringify(f));
  });

  it('reduces a Codex log, skipping injected context and encrypted compaction', () => {
    const f = parseSessionText('codex', codexLog, [ROOT]);
    expect(f.last_request?.startsWith('Fix the trabajo sitemap')).toBe(true);
    expect(f.last_assistant).toBe('Sitemap fixed and tests pass.');
    expect(f.rel.trabajo).toBe(1);
    expect(f.cwd).toBe(ROOT);
    noSecrets(JSON.stringify(f));
  });

  it('strips injected blocks from user text', () => {
    expect(realUserText('<command-name>/x</command-name>')).toBeNull();
    expect(realUserText('<system-reminder>a</system-reminder> real ask')).toBe('real ask');
  });

  it('judges ended-mid-task by the last event, and not for fresh sessions', () => {
    const facts = (end: 'tool' | 'text' | 'question') => parseSessionText('claude', claudeLog('x', end), [ROOT]);
    expect(endedMidTask(facts('tool'), now)).toBe(true);
    expect(endedMidTask(facts('question'), now)).toBe(true);
    expect(endedMidTask(facts('text'), now)).toBe(false);
    expect(endedMidTask({ ...facts('tool'), last_at: t(5) }, now)).toBe(false);
  });

  it('attributes by cwd, then tool paths, then relative paths and repo-named folders, then branch', () => {
    const base = parseSessionText('claude', '', [ROOT]);
    const f = (over: Partial<SessionFacts>) => ({ ...base, ...over });
    expect(attribute(f({ cwd: 'C:\\Claude 1\\trabajo\\src' }), checkouts, new Map()).repo).toBe('trabajo');
    expect(attribute(f({ cwd: ROOT, paths: { 'c:\\claude 1\\nombres-com-py': 3, 'c:\\claude 1\\trabajo': 1 } }), checkouts, new Map()).repo).toBe('nombres');
    expect(attribute(f({ cwd: ROOT, rel: { trabajo: 2 } }), checkouts, new Map()).repo).toBe('trabajo');
    expect(attribute(f({ cwd: 'C:\\Claude 1\\vendercrm-review-20260926' }), checkouts, new Map()).repo).toBe('vendercrm');
    expect(attribute(f({ cwd: ROOT, branch: 'claude/fix-x' }), checkouts, new Map([['claude/fix-x', 'propia.node']])).repo).toBe('propia.node');
    expect(attribute(f({ cwd: ROOT, branch: 'main' }), checkouts, new Map([['main', 'propia.node']])).repo).toBeNull();
    expect(attribute(f({ cwd: ROOT }), checkouts, new Map()).via).toBeNull();
  });

  it('counts absolute and relative folder references', () => {
    const paths: Record<string, number> = {}, rel: Record<string, number> = {};
    countPaths(JSON.stringify({ file_path: 'C:\\Claude 1\\trabajo\\a.ts' }) + ' C:/Claude 1/trabajo/b.ts', [ROOT], paths);
    expect(paths['c:\\claude 1\\trabajo']).toBe(2);
    countRelative('cd trabajo && git -C "comida-com-py" status; Set-Location ..; cat $HOME/x', rel);
    expect(rel).toMatchObject({ trabajo: 1, 'comida-com-py': 1 });
    expect(rel['..']).toBeUndefined();
  });

  it('maps only the owner account remotes to repo names', () => {
    expect(repoFromRemote('https://github.com/antonmarklundcom/trabajo.git\n', 'antonmarklundcom')).toBe('trabajo');
    expect(repoFromRemote('git@github.com:antonmarklundcom/propia.node.git', 'antonmarklundcom')).toBe('propia.node');
    expect(repoFromRemote('https://github.com/someone/else.git', 'antonmarklundcom')).toBeNull();
  });
});

describe('sessions collector', () => {
  function setup() {
    const db = testDb(), dir = tempDir();
    const claude = join(dir, 'claude', 'C--Claude-1'), codex = join(dir, 'codex', '2026', '09', '26');
    mkdirSync(claude, { recursive: true }); mkdirSync(codex, { recursive: true });
    writeFileSync(join(claude, 'a.jsonl'), claudeLog('Finish the nombres deploy ' + SECRETS.join(' ')));
    writeFileSync(join(codex, 'rollout-b.jsonl'), codexLog);
    for (const c of checkouts) db.prepare("INSERT INTO local_snapshots(path,at,repo,dirty_files,unpushed_commits,branch,ahead,behind,local_only) VALUES (?,?,?,0,0,'main',0,0,0)").run(c.path, now.toISOString(), c.repo);
    const logged: string[] = [];
    const log = { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
    const exec = vi.fn(async () => { throw new Error('no git in tests'); });
    const ctx = { db, config: { ...config, local_roots: [ROOT] }, exec, now: () => now, log };
    // Make the files old enough to be skipped when unchanged.
    const old = new Date(now.getTime() - 5 * 3_600_000);
    utimesSync(join(claude, 'a.jsonl'), old, old); utimesSync(join(codex, 'rollout-b.jsonl'), old, old);
    return { db, ctx, logged, collector: sessionsCollector(30, { claude: join(dir, 'claude'), codex: join(dir, 'codex') }) };
  }

  it('stores only redacted facts, creates a finish task, and skips unchanged files', async () => {
    const { db, ctx, logged, collector } = setup();
    expect(await collector.run(ctx)).toBe(2);
    const rows = db.prepare('SELECT * FROM agent_sessions ORDER BY tool').all() as Record<string, unknown>[];
    expect(rows.map(r => [r.tool, r.repo, r.ended_mid_task])).toEqual([['claude', 'nombres', 1], ['codex', 'trabajo', 0]]);
    noSecrets(JSON.stringify(rows));
    const tasks = db.prepare("SELECT * FROM tasks WHERE source_kind='session'").all() as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(String(tasks[0].title)).toMatch(/^Finish: Finish the nombres deploy/);
    noSecrets(JSON.stringify(tasks));
    noSecrets(logged.join('\n'));
    expect(await collector.run(ctx)).toBe(0);
  });

  it('closes a finish task once a newer session in the same repo ends cleanly', async () => {
    const { db, ctx, collector } = setup();
    await collector.run(ctx);
    db.prepare("INSERT INTO agent_sessions(id,tool,repo,project_id,started_at,last_at,last_request,ended_mid_task,summary,file_mtime) VALUES ('later','codex','nombres',NULL,?,?,'deploy again',0,'ok',1)").run(t(60), t(30));
    syncSessionTasks(db, now);
    expect(db.prepare("SELECT status FROM tasks WHERE source_kind='session'").get()).toEqual({ status: 'done' });
  });
});
