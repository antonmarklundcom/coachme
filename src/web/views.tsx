import { activeStages } from '../portfolio/schema.js';
export interface ProjectRow { id: string; name: string; stage: string; status_note: string | null; notes: string; money_weight: number }
export interface RepoRow { name: string; local_path: string | null; default_ci: string | null; last_commit_at: string | null; last_push_at: string | null; open_prs: string | null; stale_branches: string | null }
export interface LocalRow { path: string; repo: string | null; branch: string | null; dirty_files: number; unpushed_commits: number; ahead: number; behind: number; at: string; local_only: number }
export function StatusForms({ project }: { project: ProjectRow }) {
  const path = `/project/${encodeURIComponent(project.id)}`;
  if (['paused','killed'].includes(project.stage)) return <form method="post" action={`${path}/resume`}><button>Resume</button></form>;
  return <form method="post"><label>Reason<input name="reason" required maxlength={500}/></label><button formaction={`${path}/pause`}>Pause</button><button formaction={`${path}/kill`}>Kill</button></form>;
}
export function Dot({ state, label }: { state: string; label: string }) { return <span class={state === 'red' ? 'signal-red' : undefined} title={`${label}: ${state}`}><span class={`dot ${state}`} aria-label={`${label}: ${state}`}/>{label}{state === 'red' ? ' red' : ''}</span>; }
const lastActivity = (repos: RepoRow[]) => Math.max(...repos.map(r => Date.parse(r.last_commit_at ?? r.last_push_at ?? '')).filter(Number.isFinite), -Infinity);
export function ProjectCard({ project, repos, local, now }: { project: ProjectRow; repos: RepoRow[]; local: LocalRow[]; now: Date }) {
  const states = repos.map(r => r.default_ci ?? 'unknown');
  const ci = ['red','unknown','pending','green','none'].find(s => states.includes(s)) ?? 'unknown';
  const last = lastActivity(repos);
  const age = Math.max(0, (now.getTime() - last) / 86_400_000);
  const ageLabel = !Number.isFinite(age) ? 'No activity' : age < 7 ? `${Math.floor(age)}d` : `${Math.floor(age / 7)}w`;
  const prs = repos.reduce((n,r) => n + (JSON.parse(r.open_prs ?? '[]') as unknown[]).length, 0);
  const activity = age < 7 ? 'green' : age < 30 ? 'amber' : 'grey';
  const dirty = local.reduce((n,l) => n + l.dirty_files, 0), unpushed = local.reduce((n,l) => n + l.unpushed_commits, 0);
  return <article class="card" data-project={project.id}><a href={`/project/${encodeURIComponent(project.id)}`}>{project.name}</a><div class="signals"><Dot state={ci} label="CI"/><Dot state={activity} label="Activity"/><span aria-label="Last activity age">{ageLabel}</span></div>{prs > 0 && <small>{prs} open {prs === 1 ? 'PR' : 'PRs'}</small>}{(dirty > 0 || unpushed > 0) && <small>{dirty} dirty files · {unpushed} unpushed commits</small>}{['paused','killed'].includes(project.stage) ? <><small>{project.status_note}</small><StatusForms project={project}/></> : <details><summary>Pause or kill</summary><StatusForms project={project}/></details>}</article>;
}
export function Board({ projects, repos, local, now, all }: { projects: ProjectRow[]; repos: (RepoRow & { project_id: string })[]; local: LocalRow[]; now: Date; all: boolean }) {
  return <><p><a href={all ? '/portfolio' : '/portfolio?all=1'}>{all ? 'Hide paused/killed' : 'Show paused/killed'}</a></p><div class="board" role="region" aria-label="Projects by stage" tabindex={0}>{[...activeStages, ...(all ? ['paused','killed'] : [])].map(stage => <section><h2>{stage} <span class="stage-count">({projects.filter(p => p.stage === stage).length})</span></h2>{projects.filter(p => p.stage === stage).sort((a,b) => {
    const aTime = lastActivity(repos.filter(r => r.project_id === a.id)), bTime = lastActivity(repos.filter(r => r.project_id === b.id));
    return (bTime - aTime) || a.name.localeCompare(b.name);
  }).map(project => {
    const projectRepos = repos.filter(r => r.project_id === project.id);
    return <ProjectCard project={project} repos={projectRepos} local={local.filter(l => projectRepos.some(r => r.name === l.repo))} now={now}/>;
  })}</section>)}</div><section class="local-only"><h2>Local work not on GitHub</h2>{local.some(l => l.local_only) ? local.filter(l => l.local_only).sort((a,b) => a.path.localeCompare(b.path)).map(l => <article class="card"><strong>{l.path}</strong><small>Branch: {l.branch ?? 'detached'} · {l.dirty_files} dirty files · {l.unpushed_commits} unpushed commits</small></article>) : <p>No local-only checkouts observed.</p>}</section></>;
}
