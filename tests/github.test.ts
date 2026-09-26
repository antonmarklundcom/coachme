import { it,expect,vi } from 'vitest';
import { readFileSync,readdirSync } from 'node:fs';
import { parseGitHub } from '../src/collectors/github/parse.js';
import { ciState } from '../src/collectors/github/ci.js';
import { queryGitHub,QUERY } from '../src/collectors/github/query.js';
import { githubCollector } from '../src/collectors/github/index.js';
import { fixture,testDb,config } from './helpers.js';
const now = new Date('2026-09-26T00:00:00Z');
it('parses all CI states, PRs, stale non-default branches and merged deploys',() => {
  const rows = parseGitHub(JSON.parse(fixture('github/page.json')),now);
  expect(rows.snapshots.map(s => s.default_ci)).toEqual(['green','red','pending','none','unknown']);
  expect(JSON.parse(rows.snapshots[0].stale_branches)).toEqual([{name:'old-feature',committed_at:'2026-08-01T00:00:00Z'}]);
  expect(JSON.parse(rows.snapshots[0].open_prs)[0]).toMatchObject({number:12,checks:'pending',age:6});
  expect(rows.deploys).toEqual([{repo:'propia.node',at:'2026-09-23T00:00:00Z',sha:'fixture-commit',pr_number:11,source:'merged PR'}]);
  expect(ciState(null)).toBe('none'); expect(ciState({state:'SUCCESS'},true)).toBe('unknown'); expect(ciState({state:'ERROR'})).toBe('red');
  const page = JSON.parse(fixture('github/page.json')); page.errors = [{path:['repositoryOwner','repositories','nodes',0,'defaultBranchRef','target','statusCheckRollup']}];
  expect(parseGitHub(page,now).snapshots[0].default_ci).toBe('unknown');
});
it('pages 25 at a time through an injected executor',async () => {
  const page = JSON.parse(fixture('github/page.json'));
  const first = structuredClone(page); first.data.repositoryOwner.repositories.pageInfo = {hasNextPage:true,endCursor:'page-two'};
  const exec = vi.fn().mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(page));
  expect(await queryGitHub(exec,'antonmarklundcom')).toHaveLength(2);
  expect(QUERY).toContain('first:25'); expect(exec.mock.calls[1][1]).toContain('cursor=page-two');
  expect(exec.mock.calls.every(c => c[0] === 'gh' && c[1][0] === 'api' && c[1][1] === 'graphql')).toBe(true);
});
it('stores append-only snapshots and deduplicates deploys',async () => {
  const db = testDb(); const ctx = {db,config,exec:async () => fixture('github/page.json'),now:() => now,log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}};
  await githubCollector().run(ctx); await githubCollector().run(ctx);
  expect(db.prepare('SELECT count(*) AS n FROM gh_snapshots').get()).toEqual({n:10});
  expect(db.prepare('SELECT count(*) AS n FROM latest_gh_snapshot').get()).toEqual({n:5});
  expect(db.prepare('SELECT count(*) AS n FROM deploys').get()).toEqual({n:1});
});
it('GitHub collector source contains no mutation keyword',() => {
  const dir = new URL('../src/collectors/github/',import.meta.url);
  for (const file of readdirSync(dir)) expect(readFileSync(new URL(file,dir),'utf8')).not.toMatch(/\bmutation\b/i);
});
