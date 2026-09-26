/**
 * scan/stacks.ts — stack metadata, fetched instead of cloned.
 *
 * `scripts/legacy/src/runbook.js --scan` read local clones to build
 * data/stacks.json. A serverless function cannot clone, so this port fetches the
 * same handful of files through the GitHub contents API and derives the same
 * fields. Without it, runbooks would fossilize at the migrated 2026-08 snapshot
 * (plan.md §1, "two duties the old clone-based scan carried move with it").
 *
 * Stack metadata only — never a credential, only the NAMES of env vars.
 */

import type { Stack } from '../queries';
import { getFile, listDir } from './github';

/**
 * Env vars the owner needs in hand *for the DB sitting itself*. Everything else
 * in `.env.example` (API keys, payment providers, mail) is deferred: it belongs
 * to the launch, not to creating a database, and listing it would turn a
 * 20-minute task back into an hour.
 */
const SESSION_ENV = /^(DATABASE_URL|.*SESSION_SECRET|AUTH_SECRET|NEXTAUTH_SECRET|NEXTAUTH_URL|AUTH_URL)$/;
const SEED_ENV = /^(OWNER_|ADMIN_|SEED_ADMIN_)/;

function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function pickScript(scripts: Record<string, string>, names: string[]): string | null {
  for (const name of names) if (scripts?.[name]) return name;
  return null;
}

export type StackMetadata = Omit<Stack, 'repo_id' | 'scanned_at'>;

/**
 * Read one repo's stack over the API. Returns null when the repo has no
 * package.json — nothing to say, and a fabricated row would be worse than none.
 */
export async function fetchStack(fullName: string): Promise<StackMetadata | null> {
  const pkgText = await getFile(fullName, 'package.json').catch(() => null);
  if (!pkgText) return null;

  let pkg: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return null;
  }

  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const [rootFiles, prismaSchema, drizzleTs, drizzleJs] = await Promise.all([
    listDir(fullName),
    getFile(fullName, 'prisma/schema.prisma').catch(() => null),
    getFile(fullName, 'drizzle.config.ts').catch(() => null),
    getFile(fullName, 'drizzle.config.js').catch(() => null),
  ]);
  const drizzleConfig = drizzleTs ?? drizzleJs ?? '';

  let engine = 'none';
  let dialect: string | null = null;
  if (prismaSchema) {
    engine = 'prisma';
    const m = /provider\s*=\s*"(\w+)"/.exec(prismaSchema.split('datasource')[1] ?? '');
    dialect = m?.[1] === 'mysql' ? 'mysql' : 'postgresql';
  } else if (drizzleConfig || deps['drizzle-orm']) {
    engine = 'drizzle';
    const m = /dialect:\s*['"](\w+)['"]/.exec(drizzleConfig);
    dialect = m?.[1] ?? (deps['mysql2'] ? 'mysql' : 'postgresql');
  }

  // Env file: the first of the usual names that exists.
  let envFile: string | null = null;
  let envKeys: string[] = [];
  for (const name of ['.env.example', '.env.sample', '.env.local.example']) {
    const text = await getFile(fullName, name).catch(() => null);
    if (text) {
      envFile = name;
      envKeys = parseEnvKeys(text);
      break;
    }
  }

  // Package manager and migration count come from directory listings — the
  // API equivalent of the old scan's `existsSync`/`readdirSync` checks.
  const packageManager = rootFiles.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : rootFiles.includes('yarn.lock')
      ? 'yarn'
      : 'npm';
  const migrations = (
    await listDir(fullName, engine === 'prisma' ? 'prisma/migrations' : 'drizzle')
  ).filter((f) => f !== 'meta' && !f.startsWith('.')).length;

  const notes: string[] = [];
  if (engine === 'none') {
    notes.push(
      'No database dependency found in package.json — this repo may not need a DB at all. ' +
        'Verify the blocker before booking hPanel time for it.'
    );
  }
  if (prismaSchema) {
    const ext = /extensions\s*=\s*\[([^\]]+)\]/.exec(prismaSchema);
    if (ext) {
      notes.push(
        `Prisma declares Postgres extensions (${ext[1].trim()}) — the database must have them enabled ` +
          'before the first migration, or it fails on the first migrate.'
      );
    }
  }
  // `db:push` diffs the schema straight against the database, so it needs no
  // generated SQL. `db:migrate` does — and zero files there is a real trap.
  if (engine === 'drizzle' && migrations === 0 && pickScript(scripts, ['db:migrate', 'prisma:deploy', 'db:push']) === 'db:migrate') {
    notes.push(
      'No generated migrations in ./drizzle yet — `db:migrate` has nothing to apply. Run the generate step first.'
    );
  }
  if (drizzleConfig && /load-env|dotenv/.test(drizzleConfig)) {
    notes.push(
      'drizzle.config loads env files itself, but plain `tsx` scripts do not — export DATABASE_URL in the shell before running seeds.'
    );
  }
  return {
    package_name: pkg.name ?? null,
    engine,
    dialect,
    package_manager: packageManager,
    migrations,
    scripts: {
      generate: pickScript(scripts, ['db:generate', 'prisma:generate']),
      migrate: pickScript(scripts, ['db:migrate', 'prisma:deploy', 'db:push']),
      push: pickScript(scripts, ['db:push']),
      seed: pickScript(scripts, ['db:seed', 'seed:demo', 'db:import-seed', 'create-owner', 'bootstrap-admin']),
      // Deliberately excludes `db:studio` — a GUI is not a one-line verify.
      verify: pickScript(scripts, ['db:check', 'preflight', 'smoke', 'typecheck']),
      build: scripts.build ? 'build' : null,
    },
    env_file: envFile,
    env_session: envKeys.filter((k) => SESSION_ENV.test(k) || SEED_ENV.test(k)),
    env_deferred_count: envKeys.filter((k) => !(SESSION_ENV.test(k) || SEED_ENV.test(k))).length,
    notes,
  };
}
