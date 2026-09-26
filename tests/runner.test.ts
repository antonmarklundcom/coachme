import { it,expect,vi,afterEach } from 'vitest';
import { runCollector } from '../src/collectors/runner.js';
import { createScheduler } from '../src/collectors/scheduler.js';
import { freshness } from '../src/collectors/freshness.js';
import { testDb,config } from './helpers.js';
const now = new Date('2026-09-26T12:00:00Z');
afterEach(() => vi.unstubAllEnvs());
it('records a redacted failure, continues others, and supports COACH_FAIL',async () => {
  const db = testDb(), log = {info:vi.fn(),warn:vi.fn(),error:vi.fn()}, ctx = {db,config,log,exec:vi.fn(),now:() => now};
  const fail = {name:'github',intervalMin:30,run:async () => { throw new Error('token=' + 'fake-value'); }};
  const pass = {name:'local',intervalMin:15,run:vi.fn(async () => 2)};
  expect(await runCollector(fail,ctx)).toBe(false); expect(await runCollector(pass,ctx)).toBe(true);
  expect(db.prepare('SELECT ok,error_short,items FROM collector_runs ORDER BY id').all()).toEqual([{ok:0,error_short:'[REDACTED]',items:0},{ok:1,error_short:null,items:2}]);
  expect(log.error).toHaveBeenCalledWith('github: [REDACTED]');
  vi.stubEnv('COACH_FAIL','github,local'); expect(await runCollector(pass,ctx)).toBe(false); expect(pass.run).toHaveBeenCalledTimes(1);
  expect(freshness(db,[fail,pass],now).every(f => f.stale)).toBe(true);
});
it('catches up after sleep, serializes work and never overlaps ticks',async () => {
  const db = testDb(); let resolve!: () => void;
  const first = {name:'github',intervalMin:30,run:vi.fn(() => new Promise<number>(done => { resolve = () => done(1); }))};
  const second = {name:'local',intervalMin:15,run:vi.fn(async () => 1)};
  let time = now;
  const scheduler = createScheduler([first,second],{db,config,exec:vi.fn(),now:() => time,log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
  const pending = scheduler.tick(); await scheduler.tick(); expect(first.run).toHaveBeenCalledTimes(1); expect(second.run).not.toHaveBeenCalled();
  resolve(); await pending; expect(second.run).toHaveBeenCalledTimes(1);
  await scheduler.tick(); expect(first.run).toHaveBeenCalledTimes(1);
  time = new Date(now.getTime() + 4 * 60 * 60_000); expect(freshness(db,[first,second],time).every(f => f.stale)).toBe(true);
  const catchup = scheduler.tick(); resolve(); await catchup; expect(second.run).toHaveBeenCalledTimes(2); scheduler.stop();
});
