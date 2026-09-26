import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '../../lib/exec.js';
import type { Collector } from '../types.js';
import { parsePorcelain, repoFromRemote } from './parse.js';
import { detectStack } from './stack.js';
import { redact } from '../../lib/redact.js';
export interface LocalFact { path: string; name: string; repo: string | null; local_only: boolean; branch: string | null; ahead: number; behind: number; dirty_files: number; unpushed_commits: number; stack?: ReturnType<typeof detectStack> }
export async function collectLocal(roots: string[], owner: string, exec: Exec): Promise<LocalFact[]> {
  const facts: LocalFact[] = [], seen = new Set<string>();
  for (const root of roots) for (const folder of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, folder.name);
    if (!folder.isDirectory() || !existsSync(join(path, '.git')) || seen.has(path)) continue;
    seen.add(path);
    let remote: string;
    try { remote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: path }); }
    catch (error) { if (/No such remote|does not appear to be a git repository.*origin/i.test(String(error))) remote = ''; else throw error; }
    const repo = repoFromRemote(remote, owner);
    const parsed = parsePorcelain(await exec('git', ['status', '--porcelain=v2', '--branch'], { cwd: path }));
    const count = (await exec('git', ['rev-list', '--count', '--branches', '--not', '--remotes'], { cwd: path })).trim();
    if (!/^\d+$/.test(count)) throw new Error('Invalid local commit count');
    facts.push({ path, name: folder.name, repo, local_only: !repo, ...parsed, branch: parsed.branch ? redact(parsed.branch) : null, unpushed_commits: Number(count), stack: detectStack(path) });
  }
  return facts;
}
export const localCollector = (intervalMin = 15): Collector => ({ name: 'local', intervalMin, async run(ctx) {
  const facts = await collectLocal(ctx.config.local_roots, ctx.config.github_owner, ctx.exec), at = ctx.now().toISOString();
  ctx.db.transaction(() => {
    const insert = ctx.db.prepare('INSERT INTO local_snapshots(path,at,repo,dirty_files,unpushed_commits,branch,ahead,behind,local_only) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const f of facts) {
      insert.run(f.path, at, f.repo, f.dirty_files, f.unpushed_commits, f.branch, f.ahead, f.behind, Number(f.local_only));
      if (f.repo) ctx.db.prepare('UPDATE repos SET local_path=? WHERE name=?').run(f.path, f.repo);
    }
  })();
  return facts.length;
} });
