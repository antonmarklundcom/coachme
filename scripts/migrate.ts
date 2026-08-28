/**
 * migrate.ts — apply migrations/*.sql, in order, once each.
 *
 *   npm run migrate           # apply everything not yet applied
 *   npm run migrate -- --list # show what is applied and what is pending
 *
 * Plain SQL, no ORM (plan.md §5 O1 leaves this to the implementer): the schema
 * is read by hand often enough — by the next phase, by a session debugging a
 * drift item — that a file of readable DDL beats generated migrations.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './env';
import { closePool, query } from '../lib/db';

const DIR = join(process.cwd(), 'migrations');

async function main() {
  loadEnv();
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await query<{ filename: string }>(`SELECT filename FROM schema_migrations`)).map((r) => r.filename)
  );

  if (process.argv.includes('--list')) {
    for (const file of files) console.log(`${applied.has(file) ? 'applied' : 'pending'}  ${file}`);
    return;
  }

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    process.stdout.write(`applying ${file} … `);
    await query('BEGIN');
    try {
      await query(readFileSync(join(DIR, file), 'utf8'));
      await query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await query('COMMIT');
      ran++;
      console.log('ok');
    } catch (err) {
      await query('ROLLBACK');
      console.log('failed');
      throw err;
    }
  }
  console.log(ran === 0 ? 'nothing to apply — schema is current' : `${ran} migration(s) applied`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
