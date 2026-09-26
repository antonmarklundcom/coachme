import type { Collector } from '../types.js';
import { queryGitHub } from './query.js';
import { parseGitHub } from './parse.js';
export const githubCollector = (intervalMin = 30): Collector => ({
  name: 'github', intervalMin,
  async run(ctx) {
    const rows = parseGitHub(await queryGitHub(ctx.exec, ctx.config.github_owner), ctx.now());
    ctx.db.transaction(() => {
      const snapshot = ctx.db.prepare('INSERT INTO gh_snapshots(repo,at,last_push_at,last_commit_at,open_prs,default_ci,stale_branches) VALUES (@repo,@at,@last_push_at,@last_commit_at,@open_prs,@default_ci,@stale_branches)');
      rows.snapshots.forEach(row => snapshot.run(row));
      const deploy = ctx.db.prepare('INSERT OR IGNORE INTO deploys(repo,at,sha,pr_number,source) VALUES (@repo,@at,@sha,@pr_number,@source)');
      rows.deploys.forEach(row => deploy.run(row));
      rows.repos.forEach(repo => ctx.db.prepare('UPDATE repos SET default_branch=?,archived=?,on_github=1 WHERE name=?').run(repo.defaultBranchRef?.name ?? null, Number(!!repo.isArchived), repo.name));
    })();
    return rows.snapshots.length;
  },
});
