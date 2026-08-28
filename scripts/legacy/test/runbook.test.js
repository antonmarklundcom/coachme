import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dbBlockedRepos, ROOT } from '../src/portfolio.js';
import {
  loadStacks,
  renderRunbook,
  templateFor,
  context,
  dbSlug,
  assertNoSecrets,
  RUNBOOKS_DIR,
} from '../src/runbook.js';

const { stacks } = loadStacks();
const portfolio = load();

test('every db-blocked repo has scanned stack data and a generated runbook', () => {
  for (const repo of dbBlockedRepos(portfolio)) {
    assert.ok(stacks[repo.name], `no stack data for ${repo.name}`);
    assert.ok(existsSync(join(RUNBOOKS_DIR, `${repo.name}.md`)), `no runbook for ${repo.name}`);
  }
});

test('the checked-in runbooks match what the generator produces right now', () => {
  for (const [name, stack] of Object.entries(stacks)) {
    const onDisk = readFileSync(join(RUNBOOKS_DIR, `${name}.md`), 'utf8');
    const fresh = renderRunbook(stack, { repo: portfolio.repos.find((r) => r.name === name) });
    assert.equal(onDisk, fresh, `runbooks/${name}.md is stale — re-run: node src/runbook.js`);
  }
});

test('the dialect picks the template — Postgres repos never get the MySQL runbook', () => {
  assert.equal(templateFor({ dialect: 'mysql' }), 'runbook-hostinger-mysql.md');
  assert.equal(templateFor({ dialect: 'postgresql' }), 'runbook-neon-postgres.md');
  assert.match(readFileSync(join(RUNBOOKS_DIR, 'besikt.md'), 'utf8'), /Neon PostgreSQL \+ Prisma/);
  assert.match(readFileSync(join(RUNBOOKS_DIR, 'qr.md'), 'utf8'), /Hostinger MySQL \+ Drizzle/);
  assert.doesNotMatch(readFileSync(join(RUNBOOKS_DIR, 'besikt.md'), 'utf8'), /Remote MySQL/);
});

test('no runbook contains anything that looks like a real credential', () => {
  for (const file of readdirSync(RUNBOOKS_DIR)) {
    const text = readFileSync(join(RUNBOOKS_DIR, file), 'utf8');
    assert.doesNotThrow(() => assertNoSecrets(text, file));
    // Skip the deliberately elided `postgresql://...` inside error-message examples.
    for (const m of text.matchAll(/(?:mysql|postgresql):\/\/(?!\.\.\.)\S+/g)) {
      assert.match(m[0], /<(PASTE_|PREFIX|USER|NEON_HOST|REMOTE_HOST|DB)/, `unplaceheld URL in ${file}: ${m[0]}`);
    }
  }
});

test('assertNoSecrets catches what it exists to catch', () => {
  assert.throws(() => assertNoSecrets('DATABASE_URL=mysql://u_qr:hunter2seven@srv1.example:3306/db'));
  assert.throws(() => assertNoSecrets('SESSION_SECRET=8f3a9c2b7e1d4f6a'));
  assert.throws(() => assertNoSecrets('whitelist 203.0.113.42 in Remote MySQL'));
  assert.throws(() => assertNoSecrets('-----BEGIN RSA PRIVATE KEY-----'));
  // Placeholders must pass, or the generator can never emit anything.
  assert.doesNotThrow(() =>
    assertNoSecrets('DATABASE_URL=mysql://<PREFIX>_qr:<PASTE_DB_PASSWORD>@<REMOTE_HOST>:3306/<PREFIX>_qr')
  );
  assert.doesNotThrow(() => assertNoSecrets('SESSION_SECRET=<PASTE_SESSION_SECRET>'));
});

test('DATABASE_URL is spelled out once, never duplicated in the pasteable block', () => {
  for (const file of readdirSync(RUNBOOKS_DIR)) {
    const text = readFileSync(join(RUNBOOKS_DIR, file), 'utf8');
    for (const block of text.matchAll(/```\n([^`]*?)\n```/g)) {
      const keys = block[1].split('\n').map((l) => l.split('=')[0]).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
      assert.equal(keys.length, new Set(keys).size, `duplicate env key in ${file}`);
    }
  }
});

test('each runbook uses the repo\'s real package manager and real scripts', () => {
  for (const [name, stack] of Object.entries(stacks)) {
    const text = readFileSync(join(RUNBOOKS_DIR, `${name}.md`), 'utf8');
    if (stack.engine === 'none') continue; // no DB, so no commands to check
    if (stack.package_manager === 'pnpm') {
      assert.match(text, /pnpm install/, `${name} should install with pnpm`);
      assert.doesNotMatch(text, /npm run/, `${name} is a pnpm repo`);
    } else {
      assert.match(text, /npm ci/, `${name} should install with npm`);
    }
    for (const script of Object.values(stack.scripts)) {
      if (!script) continue;
      // A command in the runbook must be a script that actually exists.
      const used = [...text.matchAll(/(?:npm run|pnpm|yarn) ([\w:.-]+)/g)]
        .map((m) => m[1])
        .filter((u) => u !== 'install');
      for (const u of used) assert.ok(Object.values(stack.scripts).includes(u), `${name}: unknown script ${u}`);
    }
  }
});

test('a repo with no database dependency is flagged, not given hPanel steps', () => {
  const text = readFileSync(join(RUNBOOKS_DIR, 'inmobiliaria-py.md'), 'utf8');
  assert.equal(stacks['inmobiliaria-py'].engine, 'none');
  assert.match(text, /no database dependency at all/);
  assert.doesNotMatch(text, /Step 1 — Create the database/);
});

test('repo-specific traps reach the runbook that needs them', () => {
  assert.match(readFileSync(join(RUNBOOKS_DIR, 'paraOU.md'), 'utf8'), /vector, unaccent, pg_trgm/);
  assert.match(readFileSync(join(RUNBOOKS_DIR, 'realestateinparaguay.md'), 'utf8'), /generate them first/);
  assert.match(readFileSync(join(RUNBOOKS_DIR, 'ecom.md'), 'utf8'), /export DATABASE_URL in the shell/);
});

test('generate step appears only where db:migrate has nothing to apply', () => {
  assert.equal(context(stacks['realestateinparaguay']).needs_generate, true);
  assert.equal(context(stacks['qr']).needs_generate, false, 'db:push needs no generated SQL');
  assert.equal(context(stacks['negocio']).needs_generate, false, 'migrations already exist');
});

test('db names are hPanel-safe suffixes', () => {
  assert.equal(dbSlug('inmobiliaria-py'), 'inmobiliaria_py');
  assert.equal(dbSlug('Carpinteria.html'), 'carpinteria_html');
  assert.equal(dbSlug('paraOU'), 'paraou');
  assert.ok(dbSlug('a-very-long-repository-name').length <= 16);
});

test('templates carry no credentials either', () => {
  const dir = join(ROOT, 'templates');
  for (const file of readdirSync(dir)) {
    assert.doesNotThrow(() => assertNoSecrets(readFileSync(join(dir, file), 'utf8'), file));
  }
});
