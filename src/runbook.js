/**
 * runbook.js — per-repo DB/hosting setup runbooks.
 *
 * The point (DESIGN.md §1a): the owner should never have to *recall* anything
 * during an hPanel sitting. Everything that can be pre-computed is pre-computed
 * here, so the session is copy-paste only.
 *
 * Two phases, deliberately separate:
 *
 *   1. scan  — read a local clone of each target repo and record its stack in
 *              `data/stacks.json` (engine, dialect, migration + seed commands,
 *              env vars, package manager). Needs the clones present.
 *   2. render — turn `data/stacks.json` + templates into `runbooks/<repo>.md`.
 *              Pure, offline, deterministic, and what CI/tests exercise.
 *
 *   node src/runbook.js --scan ../antonmarklundcom   # refresh data/stacks.json
 *   node src/runbook.js                              # write every runbook
 *   node src/runbook.js besikt                       # print one to stdout
 *
 * HARD RULE: no real credentials ever land in this repo or in a runbook.
 * Every secret is a `<PASTE_...>` placeholder. `assertNoSecrets()` enforces it
 * and the unit tests run it over every generated file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, load, dbBlockedRepos } from './portfolio.js';
import { render } from './template.js';

export const STACKS_PATH = join(ROOT, 'data', 'stacks.json');
export const RUNBOOKS_DIR = join(ROOT, 'runbooks');
export const TEMPLATES_DIR = join(ROOT, 'templates');

/* ----------------------------------------------------------------- scanning */

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/**
 * Env vars the owner must have in hand *for the DB sitting itself*. Everything
 * else in `.env.example` (API keys, payment providers, mail) is deferred — it
 * belongs to the launch, not to creating a database, and listing it here would
 * turn a 20-minute task back into an hour.
 */
const SESSION_ENV = /^(DATABASE_URL|.*SESSION_SECRET|AUTH_SECRET|NEXTAUTH_SECRET|NEXTAUTH_URL|AUTH_URL)$/;
const SEED_ENV = /^(OWNER_|ADMIN_|SEED_ADMIN_)/;

function parseEnvExample(dir) {
  for (const name of ['.env.example', '.env.sample', '.env.local.example']) {
    const text = readText(join(dir, name));
    if (!text) continue;
    const keys = [];
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m) keys.push(m[1]);
    }
    return { file: name, keys };
  }
  return { file: null, keys: [] };
}

function detectPackageManager(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function detectDialect(dir, pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const drizzleConfig =
    readText(join(dir, 'drizzle.config.ts')) ?? readText(join(dir, 'drizzle.config.js')) ?? '';
  const prismaSchema = readText(join(dir, 'prisma', 'schema.prisma')) ?? '';

  if (prismaSchema) {
    const m = /provider\s*=\s*"(\w+)"/.exec(prismaSchema.split('datasource')[1] ?? '');
    return { engine: 'prisma', dialect: m?.[1] === 'mysql' ? 'mysql' : 'postgresql', prismaSchema };
  }
  if (drizzleConfig || deps?.['drizzle-orm']) {
    const m = /dialect:\s*['"](\w+)['"]/.exec(drizzleConfig);
    return { engine: 'drizzle', dialect: m?.[1] ?? (deps?.mysql2 ? 'mysql' : 'postgresql'), drizzleConfig };
  }
  return { engine: 'none', dialect: null };
}

function countMigrations(dir, engine) {
  const path = engine === 'prisma' ? join(dir, 'prisma', 'migrations') : join(dir, 'drizzle');
  if (!existsSync(path)) return 0;
  return readdirSync(path).filter((f) => f !== 'meta' && !f.startsWith('.')).length;
}

/** Pick the first script that exists, from a preference list. */
function pickScript(scripts, names) {
  for (const name of names) if (scripts?.[name]) return name;
  return null;
}

/** Read one cloned repo and describe everything the runbook needs. */
export function scanRepo(dir, name) {
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg) throw new Error(`${name}: no package.json at ${dir}`);

  const { engine, dialect, prismaSchema, drizzleConfig } = detectDialect(dir, pkg);
  const scripts = pkg.scripts ?? {};
  const env = parseEnvExample(dir);
  const migrations = countMigrations(dir, engine);

  const notes = [];
  if (engine === 'none') {
    notes.push(
      'No database dependency found in package.json — this repo may not need a DB at all. ' +
        'Verify the blocker before booking hPanel time for it.'
    );
  }
  // `db:push` diffs the schema straight against the database, so it needs no
  // generated SQL. `db:migrate` does — and zero files there is a real trap.
  const migrateScript = pickScript(scripts, ['db:migrate', 'prisma:deploy', 'db:push']);
  if (engine === 'drizzle' && migrations === 0 && migrateScript === 'db:migrate') {
    notes.push(
      'No generated migrations in ./drizzle yet — `db:migrate` has nothing to apply. Run the generate step first.'
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
  if (drizzleConfig && /load-env|dotenv/.test(drizzleConfig)) {
    notes.push(
      'drizzle.config loads env files itself, but plain `tsx` scripts do not — export DATABASE_URL in the shell before running seeds.'
    );
  }

  return {
    name,
    package_name: pkg.name ?? name,
    engine,
    dialect,
    package_manager: detectPackageManager(dir),
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
    env_file: env.file,
    env_session: env.keys.filter((k) => SESSION_ENV.test(k) || SEED_ENV.test(k)),
    env_deferred_count: env.keys.filter((k) => !(SESSION_ENV.test(k) || SEED_ENV.test(k))).length,
    notes,
  };
}

/** Scan every db-blocked repo found under `parentDir`. */
export function scanAll(parentDir, names) {
  const stacks = {};
  const missing = [];
  for (const name of names) {
    const dir = join(parentDir, name);
    if (!existsSync(dir)) {
      missing.push(name);
      continue;
    }
    stacks[name] = scanRepo(dir, name);
  }
  return { stacks, missing };
}

export function loadStacks(path = STACKS_PATH) {
  const data = readJson(path);
  if (!data) throw new Error(`no stack data at ${path} — run: node src/runbook.js --scan <dir>`);
  return data;
}

/* ---------------------------------------------------------------- rendering */

/** hPanel prefixes DB names and users with the account id; the owner types the suffix. */
export function dbSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
}

const TEMPLATE_FOR = {
  mysql: 'runbook-hostinger-mysql.md',
  postgresql: 'runbook-neon-postgres.md',
};

export function templateFor(stack) {
  return TEMPLATE_FOR[stack.dialect] ?? TEMPLATE_FOR.mysql;
}

const RUN = { npm: 'npm run', pnpm: 'pnpm', yarn: 'yarn' };

/** Everything the templates interpolate, computed in one readable place. */
export function context(stack, { repo = null, batch = null } = {}) {
  const run = RUN[stack.package_manager] ?? 'npm run';
  const slug = dbSlug(stack.name);
  const cmd = (script) => (script ? `${run} ${script}` : null);

  return {
    ...stack,
    slug,
    db_name: `<PREFIX>_${slug}`,
    db_user: `<PREFIX>_${slug}`,
    install: stack.package_manager === 'npm' ? 'npm ci' : `${stack.package_manager} install`,
    is_mysql: stack.dialect === 'mysql',
    is_postgres: stack.dialect === 'postgresql',
    is_prisma: stack.engine === 'prisma',
    is_drizzle: stack.engine === 'drizzle',
    no_db: stack.engine === 'none',
    needs_generate:
      stack.engine === 'drizzle' &&
      stack.migrations === 0 &&
      stack.scripts.migrate === 'db:migrate' &&
      !!stack.scripts.generate,
    cmd_generate: cmd(stack.scripts.generate),
    cmd_migrate: cmd(stack.scripts.migrate),
    cmd_seed: cmd(stack.scripts.seed),
    cmd_verify: cmd(stack.scripts.verify),
    cmd_build: cmd(stack.scripts.build),
    // DATABASE_URL is spelled out in full by the templates, so it must not also
    // appear in the generic list — a duplicated key in a pasted block is a bug
    // the owner would have to notice mid-session.
    env_rows: stack.env_session
      .filter((key) => key !== 'DATABASE_URL')
      .map((key) => ({ key, value: `<PASTE_${key}>` })),
    has_notes: stack.notes.length > 0,
    pct: repo?.pct ?? null,
    tier: repo?.tier ?? null,
    minutes: 20,
    batch_repos: batch ? batch.repos.join(', ') : null,
    batch_minutes: batch?.minutes ?? null,
  };
}

/**
 * Nothing that looks like a real secret may leave this module. Placeholders
 * are `<PASTE_*>` / `<PREFIX>` / `<...>`; anything else that looks like a
 * populated credential is a bug, and a loud one.
 */
const SECRET_PATTERNS = [
  { name: 'populated connection string', re: /(mysql|postgres(?:ql)?):\/\/[^<\s`"']*:[^<@\s`"']+@/i },
  // `\w*` so SESSION_SECRET / NEXTAUTH_SECRET / LEADS_TOKEN are covered too —
  // the word boundary alone stops at the underscore and misses every one of them.
  { name: 'password assignment', re: /\b\w*(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?!['"]?<)['"]?[A-Za-z0-9_\-!@#$%^&*+/]{8,}/i },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bare IPv4 address', re: /(?<![\w.<])(?:\d{1,3}\.){3}\d{1,3}(?![\w.>])/ },
];

export function assertNoSecrets(text, where = 'runbook') {
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) throw new Error(`${where}: refusing to emit — looks like a ${name}: ${JSON.stringify(m[0].slice(0, 60))}`);
  }
  return text;
}

export function renderRunbook(stack, opts = {}) {
  const template = readFileSync(join(TEMPLATES_DIR, templateFor(stack)), 'utf8');
  const out = render(template, context(stack, opts))
    .replace(/\n{3,}/g, '\n\n') // sections that rendered empty leave gaps behind
    .trimEnd();
  return assertNoSecrets(out + '\n', `runbook ${stack.name}`);
}

/* ---------------------------------------------------------------------- CLI */

function targetRepos() {
  return dbBlockedRepos(load()).map((r) => r.name);
}

async function main(argv) {
  if (argv[0] === '--scan') {
    const parent = argv[1] ?? join(ROOT, '..', 'antonmarklundcom');
    const names = targetRepos();
    const { stacks, missing } = scanAll(parent, names);
    writeFileSync(
      STACKS_PATH,
      JSON.stringify(
        {
          meta: {
            source: `scanned from local clones under ${parent.replace(process.env.HOME ?? '~', '~')}`,
            note: 'Stack metadata only — never credentials. Refresh with: node src/runbook.js --scan <dir>',
          },
          stacks,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`scanned ${Object.keys(stacks).length}/${names.length} repos → data/stacks.json`);
    if (missing.length) console.log(`missing clones (skipped): ${missing.join(', ')}`);
    return;
  }

  const { stacks } = loadStacks();
  const portfolio = load();
  const byName = new Map(portfolio.repos.map((r) => [r.name, r]));

  if (argv[0] && !argv[0].startsWith('--')) {
    const stack = stacks[argv[0]];
    if (!stack) throw new Error(`no stack data for "${argv[0]}"`);
    console.log(renderRunbook(stack, { repo: byName.get(argv[0]) }));
    return;
  }

  mkdirSync(RUNBOOKS_DIR, { recursive: true });
  for (const [name, stack] of Object.entries(stacks)) {
    const out = join(RUNBOOKS_DIR, `${name}.md`);
    writeFileSync(out, renderRunbook(stack, { repo: byName.get(name) }));
    console.log(`wrote runbooks/${name}.md  [${stack.engine}/${stack.dialect ?? 'none'}]`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
