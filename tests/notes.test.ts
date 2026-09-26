import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHandoff, parseKnownIssues, parsePlan, parseTodos, sections } from '../src/collectors/notes/parse.js';
import { readCheckoutTasks } from '../src/collectors/notes/index.js';
import { syncSourceTasks } from '../src/tasks/store.js';
import { testDb, tempDir } from './helpers.js';

const known = `# KNOWN-ISSUES

## Open
- **Lead form posts to the wrong CRM site.** The slug is still the demo one.
- Hero images 404 on
  every week page until the assets land.
- ~~Old bug~~
- [x] Already fixed box
- [ ] Sitemap misses /blog

## Fixed
- The 503 on deploy (resolved 2026-09-01)
`;

describe('notes parsers', () => {
  it('reads open known issues, joins wrapped bullets and skips fixed sections', () => {
    const tasks = parseKnownIssues('KNOWN-ISSUES.md', known);
    expect(tasks.map(t => t.title)).toEqual([
      'Lead form posts to the wrong CRM site',
      'Hero images 404 on every week page until the assets land',
      'Sitemap misses /blog',
    ]);
    expect(tasks[1].source_line).toBe(5);
    expect(tasks.every(t => t.source_kind === 'known-issue' && t.detail === 'Open')).toBe(true);
  });

  it('reads handoff next steps and unchecked boxes', () => {
    const text = '# Handoff\n## Done\n- Built the form\n## Next steps\n1. Point the DNS at Hostinger\n2. Add the RUC to the footer\n## Notes\n- [ ] Ask the client for photos\n- just a note\n';
    expect(parseHandoff('HANDOFF.md', text).map(t => t.title)).toEqual(['Point the DNS at Hostinger', 'Add the RUC to the footer', 'Ask the client for photos']);
  });

  it('takes the first plan phase with open boxes and scores closeness by the ticked share', () => {
    const text = '# Plan\n## Phase 1\n- [x] a\n- [x] b\n## Phase 2\n- [x] c\n- [x] d\n- [x] e\n- [x] f\n- [ ] Ship the pricing page\n## Phase 3\n- [ ] later\n';
    const tasks = parsePlan('plan.md', text);
    expect(tasks.map(t => t.title)).toEqual(['Ship the pricing page']);
    expect(tasks[0].closeness).toBe(0.8);
    expect(tasks[0].detail).toBe('Phase 2 (80% ticked)');
    expect(parsePlan('plan.md', '## P\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d\n')[0].closeness).toBe(0.5);
  });

  it('reads TODO and FIXME comments including an owner in parentheses', () => {
    const tasks = parseTodos('src/a.ts', "const a = 1; // TODO: wire the CRM key\n/* FIXME(founder, before launch): add the RUC */\n# TODO x\n<!-- TODO: hero copy -->\nconst todo = 'TODO';");
    expect(tasks.map(t => t.title)).toEqual(['TODO: wire the CRM key', 'TODO: add the RUC', 'TODO: hero copy']);
    expect(tasks[1].detail).toBe('TODO(founder, before launch)');
    expect(tasks[0].source_line).toBe(1);
  });

  it('ignores headings and bullets inside code fences', () => {
    expect(sections('```\n# not a heading\n- not a bullet\n```\n# Real\n- item').map(s => s.heading)).toEqual(['', 'Real']);
  });
});

describe('source task sync', () => {
  it('dedupes by hash across line moves and closes tasks whose source text disappeared', () => {
    const db = testDb(), now = new Date('2026-09-26T12:00:00Z');
    const scope = { local_path: 'C:\\Claude 1\\propia', repo: 'propia.node', project_id: null, kinds: ['known-issue' as const] };
    const item = { title: 'Lead form posts to the wrong site', source_kind: 'known-issue' as const, source_file: 'KNOWN-ISSUES.md', source_line: 4 };
    expect(syncSourceTasks(db, scope, [item], now)).toEqual({ added: 1, closed: 0 });
    expect(syncSourceTasks(db, scope, [{ ...item, source_line: 9 }], now)).toEqual({ added: 0, closed: 0 });
    expect(db.prepare('SELECT source_line, status FROM tasks').get()).toEqual({ source_line: 9, status: 'open' });
    expect(syncSourceTasks(db, scope, [], now)).toEqual({ added: 0, closed: 1 });
    expect(db.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'done' });
    // A task Anton closed is not reopened when the text comes back.
    syncSourceTasks(db, scope, [item], now);
    expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE status='open'").get()).toEqual({ n: 0 });
  });

  it('reads note files and TODOs from a checkout, skipping vendored folders', () => {
    const root = tempDir();
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'node_modules', 'x'), { recursive: true }); mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'KNOWN-ISSUES.md'), known);
    writeFileSync(join(root, 'docs', 'HANDOFF-design.md'), '## Next\n- Swap the hero image\n');
    writeFileSync(join(root, 'src', 'a.ts'), '// TODO: real todo here\n');
    writeFileSync(join(root, 'node_modules', 'x', 'b.js'), '// TODO: vendored, ignore\n');
    const tasks = readCheckoutTasks(root);
    expect(tasks.filter(t => t.source_kind === 'known-issue')).toHaveLength(3);
    expect(tasks.find(t => t.source_kind === 'handoff')?.source_file).toMatch(/docs[\\/]HANDOFF-design\.md/);
    expect(tasks.filter(t => t.source_kind === 'todo').map(t => t.title)).toEqual(['TODO: real todo here']);
  });
});
