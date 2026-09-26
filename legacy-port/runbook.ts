/**
 * runbook.ts — per-repo DB/hosting setup runbooks, rendered from a `stacks`
 * row instead of a local clone.
 *
 * A port of `scripts/legacy/src/runbook.js`'s render half (plan.md §1, "port,
 * don't rewrite"; plan.md §6 S2). The scan half — reading `package.json`,
 * `.env.example`, and the drizzle/prisma config to populate `stacks` — is O1's
 * job (`lib/scan/stacks.ts`); this module only turns that stored row plus
 * `templates/*.md` into the same copy-paste runbook the owner used to get from
 * a local clone.
 *
 * HARD RULE, unchanged from the legacy version: no real credentials ever leave
 * this module. Every secret is a `<PASTE_...>` placeholder. `assertNoSecrets`
 * enforces it and `tests/runbook.test.ts` runs it over the seeded stacks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from './render';
import type { Stack } from './queries';

const TEMPLATES_DIR = join(process.cwd(), 'templates');

/** hPanel prefixes DB names and users with the account id; the owner types the suffix. */
export function dbSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);
}

const TEMPLATE_FOR: Record<string, string> = {
  mysql: 'runbook-hostinger-mysql.md',
  postgresql: 'runbook-neon-postgres.md',
};

export function templateFor(dialect: string | null): string {
  return TEMPLATE_FOR[dialect ?? ''] ?? TEMPLATE_FOR.mysql;
}

const RUN: Record<string, string> = { npm: 'npm run', pnpm: 'pnpm', yarn: 'yarn' };

export interface RunbookBatch {
  repos: string[];
  minutes: number;
}

export interface RunbookOpts {
  pct?: number | null;
  tier?: string | null;
  batch?: RunbookBatch | null;
}

/** Everything the templates interpolate, computed in one readable place. */
export function runbookContext(repoName: string, stack: Stack, { pct = null, tier = null, batch = null }: RunbookOpts = {}) {
  const packageManager = stack.package_manager ?? 'npm';
  const run = RUN[packageManager] ?? 'npm run';
  const slug = dbSlug(repoName);
  const scripts = stack.scripts ?? {};
  const envSession = stack.env_session ?? [];
  const notes = stack.notes ?? [];
  const cmd = (script: string | null | undefined) => (script ? `${run} ${script}` : null);

  return {
    name: repoName,
    package_name: stack.package_name,
    engine: stack.engine,
    dialect: stack.dialect,
    package_manager: packageManager,
    migrations: stack.migrations,
    env_file: stack.env_file,
    slug,
    db_name: `<PREFIX>_${slug}`,
    db_user: `<PREFIX>_${slug}`,
    install: packageManager === 'npm' ? 'npm ci' : `${packageManager} install`,
    is_mysql: stack.dialect === 'mysql',
    is_postgres: stack.dialect === 'postgresql',
    is_prisma: stack.engine === 'prisma',
    is_drizzle: stack.engine === 'drizzle',
    no_db: stack.engine === 'none',
    needs_generate:
      stack.engine === 'drizzle' &&
      stack.migrations === 0 &&
      scripts.migrate === 'db:migrate' &&
      !!scripts.generate,
    cmd_generate: cmd(scripts.generate),
    cmd_migrate: cmd(scripts.migrate),
    cmd_seed: cmd(scripts.seed),
    cmd_verify: cmd(scripts.verify),
    cmd_build: cmd(scripts.build),
    // DATABASE_URL is spelled out in full by the templates, so it must not also
    // appear in the generic list — a duplicated key in a pasted block is a bug
    // the owner would have to notice mid-session.
    env_rows: envSession.filter((key) => key !== 'DATABASE_URL').map((key) => ({ key, value: `<PASTE_${key}>` })),
    env_deferred_count: stack.env_deferred_count ?? 0,
    has_notes: notes.length > 0,
    notes,
    pct,
    tier,
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
  {
    name: 'password assignment',
    re: /\b\w*(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?!['"]?<)['"]?[A-Za-z0-9_\-!@#$%^&*+/]{8,}/i,
  },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bare IPv4 address', re: /(?<![\w.<])(?:\d{1,3}\.){3}\d{1,3}(?![\w.>])/ },
];

export function assertNoSecrets(text: string, where = 'runbook'): string {
  // The same text is checked before and after HTML escaping (the dashboard
  // inlines runbooks), and `<PASTE_…>` placeholders arrive as `&lt;PASTE_…&gt;`
  // there. Decode first, or every placeholder reads as a populated secret.
  const decoded = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(decoded);
    if (m) throw new Error(`${where}: refusing to emit — looks like a ${name}: ${JSON.stringify(m[0].slice(0, 60))}`);
  }
  return text;
}

/** Render one repo's runbook as markdown, from its stored `stacks` row. */
export function renderRunbook(repoName: string, stack: Stack, opts: RunbookOpts = {}): string {
  const template = readFileSync(join(TEMPLATES_DIR, templateFor(stack.dialect)), 'utf8');
  const out = render(template, runbookContext(repoName, stack, opts))
    .replace(/\n{3,}/g, '\n\n') // sections that rendered empty leave gaps behind
    .trimEnd();
  return assertNoSecrets(out + '\n', `runbook ${repoName}`);
}
