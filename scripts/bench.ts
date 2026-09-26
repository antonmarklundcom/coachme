// Speed check (PLAN.md §10 phase 6): seed a database shaped like a month of real use and time
// the main pages. Run: npx tsx scripts/bench.ts   (uses an in-memory database, touches nothing)
import { openDb, migrate } from '../src/db/index.js';
import { configSchema } from '../src/config.js';
import { createApp } from '../src/web/server.js';
import { seed } from './bench-seed.js';

{
  const db = openDb(':memory:'); migrate(db);
  const now = new Date();
  let t = performance.now(); seed(db, now); console.log(`seeded in ${Math.round(performance.now() - t)} ms`);
  const config = configSchema.parse({ owner_tz: 'America/Asuncion', local_roots: [], github_owner: 'x', collectors: { github: 30, local: 15 }, ai: { daily_usd_cap: 0.5, model: 'claude-sonnet-5' } });
  const collectors = ['github', 'local', 'domains', 'hostinger', 'notes', 'sessions', 'crm', 'gsc'].map(name => ({ name, intervalMin: 30 }));
  const app = createApp({ db, config, collectors, portfolioPath: '/nonexistent', now: () => now, aiClient: null });
  for (const path of ['/', '/portfolio', '/project/p4', '/hosting', '/review', '/goals']) {
    await app.request(path);
    const runs = 5; t = performance.now();
    for (let i = 0; i < runs; i++) await app.request(path);
    console.log(`${path.padEnd(14)} ${((performance.now() - t) / runs).toFixed(1)} ms`);
  }
}
