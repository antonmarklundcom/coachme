import { activeStages } from '../portfolio/schema.js';
export interface ProjectRow { id: string; name: string; stage: string; status_note: string | null; notes: string; money_weight: number; site?: {state:string;sentence:string}; stage_suggestion?:string|null; stage_evidence?:string }
export interface RepoRow { name: string; local_path: string | null; default_ci: string | null; last_commit_at: string | null; last_push_at: string | null; open_prs: string | null; stale_branches: string | null }
export interface LocalRow { path: string; repo: string | null; branch: string | null; dirty_files: number; unpushed_commits: number; ahead: number; behind: number; at: string; local_only: number }
export function StatusForms({ project }: { project: ProjectRow }) {
  const path = `/project/${encodeURIComponent(project.id)}`;
  if (['paused','killed'].includes(project.stage)) return <form method="post" action={`${path}/resume`}><button>Resume</button></form>;
  return <form method="post"><label>Reason<input name="reason" required maxlength={500}/></label><button formaction={`${path}/pause`}>Pause</button><button formaction={`${path}/kill`}>Kill</button></form>;
}
export function Dot({ state, label, title }: { state: string; label: string; title?: string }) { return <span class={state === 'red' ? 'signal-red' : undefined} title={title ?? `${label}: ${state}`}><span class={`dot ${state}`} aria-label={`${label}: ${state}`}/>{label}{state === 'red' ? ' red' : ''}</span>; }
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
  return <article class="card" data-project={project.id}><a href={`/project/${encodeURIComponent(project.id)}`}>{project.name}</a><div class="signals"><Dot state={project.site?.state ?? 'grey'} label="Site" title={project.site?.sentence ?? 'No domain assigned.'}/><Dot state={ci} label="CI"/><Dot state={activity} label="Activity"/><span aria-label="Last activity age">{ageLabel}</span></div>{project.stage_suggestion && <small class="suggest">Evidence says {project.stage_suggestion}</small>}{prs > 0 && <small>{prs} open {prs === 1 ? 'PR' : 'PRs'}</small>}{(dirty > 0 || unpushed > 0) && <small>{dirty} dirty files · {unpushed} unpushed commits</small>}{['paused','killed'].includes(project.stage) ? <><small>{project.status_note}</small><StatusForms project={project}/></> : <details><summary>Pause or kill</summary><StatusForms project={project}/></details>}</article>;
}
export function Board({ projects, repos, local, now, all }: { projects: ProjectRow[]; repos: (RepoRow & { project_id: string })[]; local: LocalRow[]; now: Date; all: boolean }) {
  const suggested = projects.filter(p => p.stage_suggestion && !['paused','killed'].includes(p.stage));
  return <>{suggested.length > 0 && <form method="post" action="/portfolio/accept-stages" class="panel"><p>Evidence suggests a new stage for {suggested.length} {suggested.length === 1 ? 'project' : 'projects'}: {suggested.map(p => `${p.name} → ${p.stage_suggestion}`).join(', ')}.</p><button>Accept all</button></form>}<p><a href={all ? '/portfolio' : '/portfolio?all=1'}>{all ? 'Hide paused/killed' : 'Show paused/killed'}</a></p><div class="board" role="region" aria-label="Projects by stage" tabindex={0}>{[...activeStages, ...(all ? ['paused','killed'] : [])].map(stage => <section><h2>{stage} <span class="stage-count">({projects.filter(p => p.stage === stage).length})</span></h2>{projects.filter(p => p.stage === stage).sort((a,b) => {
    const aTime = lastActivity(repos.filter(r => r.project_id === a.id)), bTime = lastActivity(repos.filter(r => r.project_id === b.id));
    return (bTime - aTime) || a.name.localeCompare(b.name);
  }).map(project => {
    const projectRepos = repos.filter(r => r.project_id === project.id);
    return <ProjectCard project={project} repos={projectRepos} local={local.filter(l => projectRepos.some(r => r.name === l.repo))} now={now}/>;
  })}</section>)}</div><section class="local-only"><h2>Local work not on GitHub</h2>{local.some(l => l.local_only) ? local.filter(l => l.local_only).sort((a,b) => a.path.localeCompare(b.path)).map(l => <article class="card"><strong>{l.path}</strong><small>Branch: {l.branch ?? 'detached'} · {l.dirty_files} dirty files · {l.unpushed_commits} unpushed commits</small></article>) : <p>No local-only checkouts observed.</p>}</section></>;
}

interface PrItem { number?: number; title?: string; branch?: string; headRefName?: string; age_days?: number; createdAt?: string; checks?: string; ci?: string }
interface BranchItem { name?: string; committedDate?: string; last_commit_at?: string; age_days?: number }
const day = (iso: string | null | undefined, now: Date) => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return 'no data'; const d = Math.floor((now.getTime() - t) / 86_400_000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
export function RepoPanel({ repo, local, now }: { repo: RepoRow; local: LocalRow[]; now: Date }) {
  const prs = JSON.parse(repo.open_prs ?? '[]') as PrItem[];
  const stale = JSON.parse(repo.stale_branches ?? '[]') as (BranchItem | string)[];
  return <section class="panel"><h2>{repo.name}</h2><div class="signals"><Dot state={repo.default_ci ?? 'unknown'} label="CI"/><span>last commit {day(repo.last_commit_at, now)}</span></div>
    <h3>Open PRs ({prs.length})</h3>{prs.length ? <ul>{prs.map(p => <li>#{p.number} {p.title} <small>{p.branch ?? p.headRefName} · {p.checks ?? p.ci ?? 'no checks'} · opened {day(p.createdAt, now)}</small></li>)}</ul> : <p>None.</p>}
    <h3>Stale branches ({stale.length})</h3>{stale.length ? <details><summary>Branches with no commit for 14+ days</summary><ul>{stale.map(b => typeof b === 'string' ? <li>{b}</li> : <li>{b.name} <small>last commit {day(b.committedDate ?? b.last_commit_at, now)}</small></li>)}</ul></details> : <p>None.</p>}
    <h3>Local checkouts</h3>{local.length ? <ul>{local.map(l => <li>{l.path}: {l.branch ?? 'detached'} · {l.dirty_files} dirty · {l.unpushed_commits} unpushed{l.behind > 0 ? ` · ${l.behind} behind` : ''}</li>)}</ul> : <p>Not cloned on this PC.</p>}
  </section>;
}
