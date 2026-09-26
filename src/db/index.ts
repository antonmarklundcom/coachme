import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export type DB = Database.Database;
export function openDb(path = resolve('data/coach.db')): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  return db;
}
export function migrate(db: DB, dir = fileURLToPath(new URL('../../migrations/', import.meta.url))): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) return;
      db.exec(readFileSync(resolve(dir, name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
}
