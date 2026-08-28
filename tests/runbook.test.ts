/**
 * The runbook generator (plan.md §6 S2) — a port of `src/runbook.js` onto a
 * `stacks` row instead of a local clone (lib/runbook.ts). The exit criterion
 * (plan.md §6 S2) is that a real DB-blocked repo's runbook "matches the
 * quality bar of the existing runbooks/*.md files" — checked here the
 * strongest possible way: byte-identical output from the same inputs the
 * legacy generator scanned, for every repo the 2026-08 baseline generated a
 * runbook for.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoSecrets, dbSlug, renderRunbook, templateFor } from '../lib/runbook';
import { markdownToHtml } from '../lib/markdown';
import type { Stack } from '../lib/queries';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const stacksData = JSON.parse(read('data/stacks.json')) as {
  stacks: Record<string, Omit<Stack, 'repo_id' | 'scanned_at'> & { name: string }>;
};
const portfolio = JSON.parse(read('data/portfolio.json')) as {
  repos: { name: string; pct: number; tier: string }[];
};

function stackFor(name: string): Stack {
  const entry = stacksData.stacks[name];
  return {
    repo_id: 0,
    scanned_at: '2026-08-28',
    package_name: entry.package_name,
    engine: entry.engine,
    dialect: entry.dialect,
    package_manager: entry.package_manager,
    migrations: entry.migrations,
    scripts: entry.scripts,
    env_file: entry.env_file,
    env_session: entry.env_session,
    env_deferred_count: entry.env_deferred_count,
    notes: entry.notes,
  };
}

describe('renderRunbook matches the legacy generator byte-for-byte', () => {
  for (const name of Object.keys(stacksData.stacks)) {
    it(`renders ${name} identically to runbooks/${name}.md`, () => {
      const repo = portfolio.repos.find((r) => r.name === name);
      const out = renderRunbook(name, stackFor(name), { pct: repo?.pct ?? null, tier: repo?.tier ?? null });
      expect(out).toBe(read(`runbooks/${name}.md`));
    });
  }
});

describe('runbook template selection', () => {
  it('picks Neon Postgres for a postgresql dialect', () => {
    expect(templateFor('postgresql')).toBe('runbook-neon-postgres.md');
  });
  it('picks Hostinger MySQL for mysql and for anything unrecognized', () => {
    expect(templateFor('mysql')).toBe('runbook-hostinger-mysql.md');
    expect(templateFor(null)).toBe('runbook-hostinger-mysql.md');
  });
});

describe('dbSlug', () => {
  it('lowercases, strips non-alphanumerics, and caps at 16 chars (hPanel field limit)', () => {
    expect(dbSlug('Besikt')).toBe('besikt');
    expect(dbSlug('inmobiliaria-py')).toBe('inmobiliaria_py');
    expect(dbSlug('a-very-long-repository-name')).toHaveLength(16);
  });
});

describe('assertNoSecrets', () => {
  it('passes placeholder-only text', () => {
    expect(() => assertNoSecrets('DATABASE_URL=postgresql://<USER>:<PASTE_DB_PASSWORD>@<NEON_HOST>/<DB>')).not.toThrow();
  });
  it('refuses a populated connection string', () => {
    expect(() => assertNoSecrets('postgresql://user:hunter2secret@db.example.com/mydb')).toThrow(/populated connection string/);
  });
  it('refuses a populated secret-looking assignment', () => {
    expect(() => assertNoSecrets('NEXTAUTH_SECRET=Zx8pQr2mNv7wLk4T')).toThrow(/password assignment/);
  });
  it('refuses a private key block', () => {
    expect(() => assertNoSecrets('-----BEGIN PRIVATE KEY-----\nMIIB...')).toThrow(/private key block/);
  });
  it('refuses a bare IPv4 address', () => {
    expect(() => assertNoSecrets('the remote host is 203.0.113.42')).toThrow(/bare IPv4 address/);
  });
  it('decodes HTML entities before checking, so an escaped placeholder never false-positives', () => {
    expect(() => assertNoSecrets('DATABASE_URL=postgresql://&lt;USER&gt;:&lt;PASTE_DB_PASSWORD&gt;@&lt;NEON_HOST&gt;/&lt;DB&gt;')).not.toThrow();
  });
});

describe('the rendered runbook, as the dashboard actually shows it', () => {
  it('never emits a real credential end to end (render → markdownToHtml)', () => {
    for (const name of Object.keys(stacksData.stacks)) {
      const repo = portfolio.repos.find((r) => r.name === name);
      const md = renderRunbook(name, stackFor(name), { pct: repo?.pct ?? null, tier: repo?.tier ?? null });
      // renderRunbook already asserts on the markdown; assert again on the HTML
      // the dashboard actually injects, since escaping changes what the regexes see.
      expect(() => assertNoSecrets(markdownToHtml(md))).not.toThrow();
    }
  });

  it("besikt's runbook renders real HTML structure — headings, a fenced command block, the traps note", () => {
    const repo = portfolio.repos.find((r) => r.name === 'besikt')!;
    const html = markdownToHtml(renderRunbook('besikt', stackFor('besikt'), { pct: repo.pct, tier: repo.tier }));
    expect(html).toMatch(/<h1>/);
    expect(html).toMatch(/<h2>Step 1/);
    expect(html).toMatch(/<pre><code>/);
    expect(html).toMatch(/<table>/); // the "if it goes wrong" table
  });

  it('a no-db repo (engine: none) renders its warning instead of DB steps', () => {
    const stack: Stack = {
      repo_id: 0,
      package_name: 'mystery-app',
      engine: 'none',
      dialect: null,
      package_manager: 'npm',
      migrations: 0,
      scripts: {},
      env_file: null,
      env_session: [],
      env_deferred_count: 0,
      notes: ['No database dependency found in package.json — this repo may not need a DB at all.'],
      scanned_at: '2026-08-28',
    };
    const out = renderRunbook('mystery-app', stack, { pct: 40, tier: 'experiment' });
    expect(out).toMatch(/no database dependency at all/i);
    expect(out).not.toMatch(/Create the database and user/);
  });
});
