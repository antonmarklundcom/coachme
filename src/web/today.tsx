import type { Hono } from 'hono';
import type { DB } from '../db/index.js';
import type { TaskRow } from '../tasks/store.js';
import { addManualTask, setTaskStatus } from '../tasks/store.js';
import { buildToday, type TodayDeps, type TodayView } from '../today/service.js';
import { alertSentence } from '../alerts/index.js';

type Render = (title: string, child: unknown) => string | Promise<string>;
interface AlertRow { kind: string; subject: string; severity: string }

const css = `
.actions{display:grid;gap:14px;margin:12px 0 28px}
.action{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.action h3{margin:0 0 4px;font-size:1.05rem}.action .meta{color:var(--muted);font-size:.9rem;margin:0 0 10px}
.action .why{margin:0 0 12px}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.row form{display:inline}button,.btn{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:inherit;cursor:pointer}
button.primary{background:#1f5eff;border-color:#1f5eff;color:#fff}.prompt{width:100%;min-height:9em;font:13px/1.45 ui-monospace,monospace;margin-top:10px}
.money{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0}.money li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
.alerts-red li{color:#b3261e;font-weight:600}.muted{color:var(--muted)}.inbox-item{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}
textarea.capture,input.capture{width:100%;font:inherit;padding:8px}`;

const copyScript = `document.addEventListener('click',async e=>{const b=e.target.closest('[data-copy]');if(!b)return;const t=document.getElementById(b.dataset.copy);
try{await navigator.clipboard.writeText(t.value)}catch{t.hidden=false;t.select();document.execCommand('copy')}const o=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=o,1500)});
document.addEventListener('click',e=>{const b=e.target.closest('[data-show]');if(!b)return;const t=document.getElementById(b.dataset.show);t.hidden=!t.hidden});`;

const Style = () => <style>{css}</style>;
const Script = () => <script dangerouslySetInnerHTML={{ __html: copyScript }} />;

function TaskButtons({ task, back }: { task: TaskRow; back: string }) {
  const post = (action: string, label: string, cls?: string) => <form method="post" action={`/task/${task.id}/${action}`}><input type="hidden" name="back" value={back} /><button class={cls}>{label}</button></form>;
  return <>{post('done', 'Done')}{post('drop', 'Drop')}{task.pinned ? post('unpin', 'Unpin') : post('pin', 'Pin')}</>;
}

export function TodayPage({ view, red, amber }: { view: TodayView; red: string[]; amber: string[] }) {
  const ai = view.ai.state === 'off' ? 'AI off (no ANTHROPIC_API_KEY): deterministic ranking and reasons.'
    : view.ai.state === 'capped' ? `AI paused: daily cap of $${view.ai.cap.toFixed(2)} reached.`
    : `AI on · $${view.ai.spentToday.toFixed(3)} of $${view.ai.cap.toFixed(2)} spent today.`;
  return <div>
    <Style />
    {red.length > 0 && <section><h2>Broken now</h2><ul class="alerts-red">{red.map(s => <li>{s}</li>)}</ul></section>}
    <h2>Your 3 things today</h2>
    {view.actions.length === 0 ? <p class="muted">No open tasks yet. Tasks come from KNOWN-ISSUES, HANDOFF and plan checklists, TODOs, agent sessions that stopped mid-task, and your inbox.</p> :
      <div class="actions">{view.actions.map((a, i) => <article class="action" data-task={a.task.id}>
        <h3>{i + 1}. {a.task.title}</h3>
        <p class="meta">{a.project ? <a href={`/project/${encodeURIComponent(a.project.id)}`}>{a.project.name}</a> : (a.task.repo ?? 'no project')} · {a.task.source_file ? `${a.task.source_file}${a.task.source_line ? `:${a.task.source_line}` : ''}` : a.task.source_kind}{a.task.pinned ? ' · pinned' : ''}</p>
        <p class="why">{a.reason}{a.aiReason ? '' : ''}</p>
        <div class="row"><button class="primary" data-copy={`prompt-${a.task.id}`}>Copy prompt</button><button data-show={`prompt-${a.task.id}`}>Show prompt</button><TaskButtons task={a.task} back="/" /></div>
        <textarea id={`prompt-${a.task.id}`} class="prompt" readonly hidden>{a.prompt}</textarea>
      </article>)}</div>}
    <h2>Closest to money</h2>
    <ul class="money">{view.closest.map(p => <li><a href={`/project/${encodeURIComponent(p.id)}`}>{p.name}</a> <span class="muted">{p.stage} · weight {p.money_weight}</span></li>)}</ul>
    {amber.length > 0 && <details><summary>{amber.length} amber alerts</summary><ul>{amber.map(s => <li>{s}</li>)}</ul></details>}
    <p class="muted">{view.openTasks} open tasks · <a href="/tasks">all tasks</a> · {view.unattributedSessions} agent sessions in the last 14 days could not be tied to a repo · {ai}</p>
    <Script />
  </div>;
}

export function TasksPage({ tasks, projects }: { tasks: (TaskRow & { project_name: string | null })[]; projects: { id: string; name: string }[] }) {
  return <div><Style />
    <form method="post" action="/tasks" class="row"><input class="capture" name="title" required maxlength={200} placeholder="New task" style="flex:1" />
      <select name="project_id"><option value="">No project</option>{projects.map(p => <option value={p.id}>{p.name}</option>)}</select><button class="primary">Add</button></form>
    <table><thead><tr><th>Task</th><th>Project</th><th>Source</th><th>Effort</th><th /></tr></thead><tbody>
      {tasks.map(t => <tr><td>{t.title}</td><td>{t.project_name ?? t.repo ?? '-'}</td><td>{t.source_file ? `${t.source_file}${t.source_line ? `:${t.source_line}` : ''}` : t.source_kind}</td>
        <td><form method="post" action={`/task/${t.id}/effort`} class="row"><input type="hidden" name="back" value="/tasks" /><input name="hours" type="number" min="0.25" max="80" step="0.25" value={String(t.effort_h ?? 1)} style="width:5em" /><button>Set</button></form></td>
        <td class="row"><TaskButtons task={t} back="/tasks" /></td></tr>)}
    </tbody></table></div>;
}

interface InboxRow { id: number; text: string; source: string; created_at: string }
export function InboxPage({ items, projects }: { items: InboxRow[]; projects: { id: string; name: string }[] }) {
  return <div><Style />
    <form method="post" action="/inbox"><label>Capture anything: a task, an idea, a worry<textarea class="capture" name="text" required maxlength={2000} rows={2} /></label><p><button class="primary">Add to inbox</button></p></form>
    <p class="muted">Also: <code>coach add "…"</code> from any terminal.</p>
    <h2>Untriaged ({items.length})</h2>
    {items.length === 0 ? <p class="muted">Inbox zero.</p> : items.map(i => <div class="inbox-item"><p>{i.text}</p><p class="muted">{i.source} · {i.created_at.slice(0, 16).replace('T', ' ')}</p>
      <div class="row"><form method="post" action={`/inbox/${i.id}/task`} class="row"><select name="project_id"><option value="">No project</option>{projects.map(p => <option value={p.id}>{p.name}</option>)}</select><button>Make task</button></form>
        <form method="post" action={`/inbox/${i.id}/idea`}><button>Park as idea</button></form><form method="post" action={`/inbox/${i.id}/drop`}><button>Drop</button></form></div></div>)}
  </div>;
}

interface SessionRow { tool: string; last_at: string | null; last_request: string | null; ended_mid_task: number; summary: string | null; branch: string | null }
export function ProjectWork({ tasks, sessions }: { tasks: TaskRow[]; sessions: SessionRow[] }) {
  return <section class="panel"><Style />
    <h2>Open tasks ({tasks.length})</h2>
    {tasks.length ? <ul>{tasks.map(t => <li>{t.title} <span class="muted">{t.source_file ? `${t.source_file}${t.source_line ? `:${t.source_line}` : ''}` : t.source_kind}</span></li>)}</ul> : <p class="muted">None.</p>}
    <h2>Agent sessions ({sessions.length})</h2>
    {sessions.length ? <ul>{sessions.map(s => <li><strong>{s.tool}</strong> {s.last_at?.slice(0, 16).replace('T', ' ')}{s.ended_mid_task ? ' · stopped mid-task (heuristic)' : ''}{s.branch ? ` · ${s.branch}` : ''}<br /><span class="muted">{s.last_request ?? ''}</span></li>)}</ul> : <p class="muted">No agent sessions seen for this project.</p>}
  </section>;
}

export function projectWork(db: DB, projectId: string) {
  return {
    tasks: db.prepare("SELECT * FROM tasks WHERE project_id=? AND status='open' ORDER BY pinned DESC, closeness DESC, id LIMIT 50").all(projectId) as TaskRow[],
    sessions: db.prepare('SELECT tool,last_at,last_request,ended_mid_task,summary,branch FROM agent_sessions WHERE project_id=? ORDER BY last_at DESC LIMIT 10').all(projectId) as SessionRow[],
  };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const safeBack = (v: unknown) => (typeof v === 'string' && /^\/[\w\-/?=&.%]*$/.test(v) && !v.startsWith('//') ? v : '/');

export function registerTodayRoutes(app: Hono, deps: TodayDeps & { render: Render; projects: () => { id: string; name: string }[] }) {
  const { db } = deps;
  app.get('/', async c => {
    const alerts = db.prepare('SELECT kind, subject, severity FROM alerts WHERE closed_at IS NULL ORDER BY opened_at DESC').all() as AlertRow[];
    const now = deps.now();
    const view = await buildToday(deps);
    return c.html(deps.render('Today', <TodayPage view={view} red={alerts.filter(a => a.severity === 'red').map(a => alertSentence(db, a, now))} amber={alerts.filter(a => a.severity === 'amber').map(a => alertSentence(db, a, now))} />));
  });
  app.get('/tasks', c => c.html(deps.render('Tasks', <TasksPage projects={deps.projects()} tasks={db.prepare(`SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
    WHERE t.status='open' ORDER BY t.pinned DESC, p.money_weight DESC, t.closeness DESC, t.id LIMIT 500`).all() as (TaskRow & { project_name: string | null })[]} />)));
  app.post('/tasks', async c => {
    const body = await c.req.parseBody(), title = text(body.title, 200), project = text(body.project_id, 100) || null;
    if (!title) return c.text('A title is required', 400);
    if (project && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) return c.text('Unknown project', 400);
    addManualTask(db, { project_id: project, title }, deps.now());
    return c.redirect('/tasks', 303);
  });
  for (const action of ['done', 'drop', 'pin', 'unpin', 'effort'] as const) app.post(`/task/:id/${action}`, async c => {
    const id = Number(c.req.param('id')), body = await c.req.parseBody();
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM tasks WHERE id=?').get(id)) return c.text('Task not found', 404);
    const now = deps.now().toISOString();
    if (action === 'done' || action === 'drop') setTaskStatus(db, id, action === 'done' ? 'done' : 'dropped', deps.now());
    else if (action === 'effort') {
      const h = Number(body.hours);
      if (!Number.isFinite(h) || h < 0.25 || h > 80) return c.text('Effort must be between 0.25 and 80 hours', 400);
      db.prepare('UPDATE tasks SET effort_h=?, updated_at=? WHERE id=?').run(h, now, id);
    } else db.prepare('UPDATE tasks SET pinned=?, updated_at=? WHERE id=?').run(action === 'pin' ? 1 : 0, now, id);
    return c.redirect(safeBack(body.back), 303);
  });
  app.get('/inbox', c => c.html(deps.render('Inbox', <InboxPage projects={deps.projects()} items={db.prepare('SELECT id,text,source,created_at FROM inbox WHERE triaged_as IS NULL ORDER BY created_at DESC').all() as InboxRow[]} />)));
  app.post('/inbox', async c => {
    const t = text((await c.req.parseBody()).text, 2000);
    if (!t) return c.text('Nothing to capture', 400);
    addInbox(db, t, 'ui', deps.now());
    return c.redirect('/inbox', 303);
  });
  app.post('/inbox/:id/:as{task|idea|drop}', async c => {
    const id = Number(c.req.param('id')), as = c.req.param('as') as 'task' | 'idea' | 'drop', body = await c.req.parseBody();
    const item = db.prepare('SELECT * FROM inbox WHERE id=? AND triaged_as IS NULL').get(id) as InboxRow | undefined;
    if (!item) return c.text('Inbox item not found', 404);
    const project = text(body.project_id, 100) || null;
    if (project && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) return c.text('Unknown project', 400);
    db.transaction(() => {
      if (as === 'task') addManualTask(db, { project_id: project, title: item.text, source_kind: 'inbox' }, deps.now());
      if (as === 'idea') db.prepare("INSERT INTO ideas(text,created_at,status) VALUES (?,?,'parked')").run(item.text, deps.now().toISOString());
      db.prepare('UPDATE inbox SET triaged_as=? WHERE id=?').run(as === 'drop' ? 'dropped' : as, id);
    })();
    return c.redirect('/inbox', 303);
  });
}

export function addInbox(db: DB, value: string, source: 'ui' | 'cli' | 'telegram', now: Date) {
  return Number(db.prepare('INSERT INTO inbox(text,source,created_at) VALUES (?,?,?)').run(value.trim().slice(0, 2000), source, now.toISOString()).lastInsertRowid);
}
