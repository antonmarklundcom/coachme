/**
 * db.ts — the one place that talks to Postgres.
 *
 * Driver choice (plan.md §5 O1, "implementer's call"): plain `pg`. Neon speaks
 * the wire protocol over TCP, so the same pool works against a Neon pooled
 * connection string in production and a local Postgres in a build session — no
 * driver swap, nothing Neon-proprietary. Routes that use it must run on the
 * Node runtime (`export const runtime = 'nodejs'`), which is why the auth check
 * in middleware.ts is a stateless signed cookie and never a database lookup.
 */

import { Pool, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function databaseUrl(): string | null {
  return process.env.DATABASE_URL ?? null;
}

/** Throws only when something actually needs the database (§4.5: degrade, don't crash at build). */
export function getPool(): Pool {
  if (pool) return pool;
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and point it at your Neon database.'
    );
  }
  pool = new Pool({
    connectionString: url,
    // Neon requires TLS; a local postgres:// on localhost does not offer it.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 10_000,
  });
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
  return result.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
