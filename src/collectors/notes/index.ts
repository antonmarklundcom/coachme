import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Collector } from '../types.js';
import type { SourceTask } from '../../tasks/store.js';
import { syncSourceTasks } from '../../tasks/store.js';
import { parseNoteFile } from './parse.js';

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', '.next', '.git', '.turbo', '.vercel', 'coverage', 'out', '.cache', 'public', 'uploads', 'assets']);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|php|py|astro|vue|svelte|css|scss|html|sql)$/i;
const MAX_FILE = 300 * 1024, MAX_FILES = 4000, MAX_TODOS = 20;

/** Note files are read from the checkout root and docs/ only. */
export function noteFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of [root, join(root, 'docs')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (/^(KNOWN-ISSUES|HANDOFF[^/\\]*|plan)\.md$/i.test(name)) out.push(join(dir, name));
  }
  return out;
}

/** Source files for TODO scanning, breadth-first, skipping vendored and generated folders. */
export function codeFiles(root: string): string[] {
  const out: string[] = [], queue = [root];
  while (queue.length && out.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !(e.name === 'history' && dir.endsWith('docs'))) queue.push(join(dir, e.name)); }
      else if (CODE.test(e.name) && !/\.min\./.test(e.name)) out.push(join(dir, e.name));
    }
  }
  return out;
}

const read = (path: string) => { try { return statSync(path).size <= MAX_FILE ? readFileSync(path, 'utf8') : null; } catch { return null; } };

export function readCheckoutTasks(root: string): SourceTask[] {
  const tasks: SourceTask[] = [];
  for (const file of noteFiles(root)) { const text = read(file); if (text) tasks.push(...parseNoteFile(relative(root, file), text)); }
  let todos = 0;
  for (const file of codeFiles(root)) {
    if (todos >= MAX_TODOS) break;
    const text = read(file);
    if (!text || !/TODO|FIXME/.test(text)) continue;
    const found = parseNoteFile(relative(root, file), text).slice(0, MAX_TODOS - todos);
    todos += found.length; tasks.push(...found);
  }
  return tasks;
}

export function notesCollector(intervalMin = 60): Collector {
  return {
    name: 'notes', intervalMin,
    async run(ctx) {
      const checkouts = ctx.db.prepare('SELECT l.path, l.repo, r.project_id FROM latest_local_snapshot l LEFT JOIN repos r ON r.name = l.repo').all() as { path: string; repo: string | null; project_id: string | null }[];
      let items = 0;
      for (const c of checkouts) {
        if (!existsSync(c.path)) continue;
        const tasks = readCheckoutTasks(c.path);
        syncSourceTasks(ctx.db, { local_path: c.path, repo: c.repo, project_id: c.project_id, kinds: ['known-issue', 'handoff', 'plan-phase', 'todo'] }, tasks, ctx.now());
        items += tasks.length;
      }
      return items;
    },
  };
}
