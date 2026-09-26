import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../../lib/redact.js';
export function detectStack(path: string) {
  const read = (name: string) => existsSync(join(path, name)) ? readFileSync(join(path, name), 'utf8') : '';
  let pkg: { name?: string; dependencies?: Record<string,string>; devDependencies?: Record<string,string>; scripts?: Record<string,string> };
  try { pkg = JSON.parse(read('package.json')); } catch { return null; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }, scripts = pkg.scripts ?? {};
  const prisma = read('prisma/schema.prisma'), drizzle = read('drizzle.config.ts') || read('drizzle.config.js');
  const engine = prisma ? 'prisma' : drizzle || deps['drizzle-orm'] ? 'drizzle' : 'none';
  const dialect = engine === 'prisma' ? /provider\s*=\s*"(\w+)"/.exec(prisma.split('datasource')[1] ?? '')?.[1] ?? 'postgresql'
    : engine === 'drizzle' ? /dialect:\s*['"](\w+)['"]/.exec(drizzle)?.[1] ?? (deps.mysql2 ? 'mysql' : 'postgresql') : null;
  const migrationDir = engine === 'prisma' ? 'prisma/migrations' : 'drizzle';
  const migrations = existsSync(join(path, migrationDir)) ? readdirSync(join(path, migrationDir)).filter(f => f !== 'meta' && !f.startsWith('.')).length : 0;
  const envFile = ['.env.example', '.env.sample', '.env.local.example'].find(f => existsSync(join(path, f)));
  const keys = [...read(envFile ?? '.env.example').matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]);
  const session = /^(DATABASE_URL|.*SESSION_SECRET|AUTH_SECRET|NEXTAUTH_SECRET|NEXTAUTH_URL|AUTH_URL|OWNER_.*|ADMIN_.*|SEED_ADMIN_.*)$/;
  const pick = (...names: string[]) => names.find(n => scripts[n]) ?? null;
  const notes: string[] = [];
  if (engine === 'none') notes.push('No database dependency found; verify whether a database is needed.');
  if (/extensions\s*=/.test(prisma)) notes.push('Prisma declares database extensions; enable them before migrating.');
  if (engine === 'drizzle' && !migrations && pick('db:migrate','prisma:deploy','db:push') === 'db:migrate') notes.push('Generate migrations before running db:migrate.');
  if (/load-env|dotenv/.test(drizzle)) notes.push('Drizzle loads env files; standalone scripts may need exported environment variables.');
  return { package_name: pkg.name ? redact(pkg.name) : null, engine, dialect, migrations, migrations_dir: migrationDir,
    package_manager: existsSync(join(path, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(path, 'yarn.lock')) ? 'yarn' : 'npm',
    scripts: { generate: pick('db:generate','prisma:generate'), migrate: pick('db:migrate','prisma:deploy','db:push'), push: pick('db:push'), seed: pick('db:seed','seed:demo','db:import-seed','create-owner','bootstrap-admin'), verify: pick('db:check','preflight','smoke','typecheck'), build: pick('build') },
    env_file: envFile ?? null, env_session: keys.filter(k => session.test(k)), env_deferred_count: keys.filter(k => !session.test(k)).length, notes };
}
