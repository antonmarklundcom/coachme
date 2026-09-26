import type { Hono } from 'hono';
import { parseDocument } from 'yaml';
import type { DB } from '../db/index.js';
import type { AiDeps } from '../ai/client.js';
import { generateReview, sections, type StoredReview, type WeeklyFacts } from '../review/weekly.js';
import { StatusForms } from './views.js';
import { setProjectStatus } from '../portfolio/patch.js';
import { loadPortfolio } from '../portfolio/load.js';
import { activeStages } from '../portfolio/schema.js';
import { redact } from '../lib/redact.js';

type Render = (title: string, child: unknown) => string | Promise<string>;
interface ProjectOption { id: string; name: string; stage: string }
interface IdeaRow { id: number; text: string; created_at: string; status: string; gate_more_valuable_than: string | null; gate_pause_project: string | null }

export function ReviewPage({ review, archive }: { review: StoredReview | null; archive: { week: string; headline: string }[] }) {
  const facts = review ? JSON.parse(review.facts) as WeeklyFacts : null;
  return <div>
    <form method="post" action="/review/generate"><button>Generate this week's review now</button></form>
    {!review || !facts ? <p>No weekly review yet. It is written every Sunday at 18:00 (Asunción) and sent to Telegram.</p> : <>
      <h2>{review.headline}</h2>
      <p><small>Week of {review.week} · generated {review.generated_at.slice(0, 16).replace('T', ' ')} UTC · {review.ai ? 'prose by AI over the facts below' : 'deterministic'} · {review.sent_at ? `sent to Telegram ${review.sent_at.slice(0, 16).replace('T', ' ')} UTC` : 'not sent'}</small></p>
      {review.body && review.body.split(/\n{2,}/).map(p => <p>{p}</p>)}
      {sections(facts).map(s => <section class="panel" data-section={s.title}><h3>{s.title}</h3>{s.lines.length ? <ul>{s.lines.map(l => <li>{l}</li>)}</ul> : <p><small>None.</small></p>}
        {s.title === 'Suggested kills' && facts.kills.map(k => <div><strong>{k.name}</strong><StatusForms project={{ id: k.project_id, name: k.name, stage: k.stage, status_note: null, notes: '', money_weight: k.money_weight }} /></div>)}</section>)}
    </>}
    {archive.length > 0 && <><h2>Archive</h2><ul>{archive.map(a => <li><a href={`/review?week=${a.week}`}>{a.week}</a> {a.headline}</li>)}</ul></>}
  </div>;
}

export function IdeasPage({ parked, promoted }: { parked: IdeaRow[]; promoted: IdeaRow[] }) {
  return <div>
    <p>New ideas go here, not into new repos. Promoting one always asks which live project it beats and what gets paused.</p>
    <form method="post" action="/ideas"><textarea class="capture" name="text" required maxlength={2000} rows={2} style="width:100%" /><p><button>Park idea</button></p></form>
    <h2>Parked ({parked.length})</h2>
    {parked.length ? <ul>{parked.map(i => <li data-idea={i.id}>{i.text} <small>{i.created_at.slice(0, 10)} · <a href={`/ideas/${i.id}/promote`}>Promote to project…</a></small>
      <form method="post" action={`/ideas/${i.id}/drop`}><button>Drop</button></form></li>)}</ul> : <p><small>Nothing parked.</small></p>}
    {promoted.length > 0 && <><h2>Promoted</h2><ul>{promoted.map(i => <li>{i.text} <small>more valuable than {i.gate_more_valuable_than} · paused {i.gate_pause_project}</small></li>)}</ul></>}
  </div>;
}

export function PromoteGate({ idea, live, pausable, error }: { idea: IdeaRow; live: ProjectOption[]; pausable: ProjectOption[]; error?: string }) {
  return <div>
    <p>{idea.text}</p>
    {error && <p class="signal-red">{error}</p>}
    {!live.length ? <p>No project is live or earning, so there is nothing this idea can beat yet. Finish one first.</p> :
      <form method="post" action={`/ideas/${idea.id}/promote`} style="display:grid;gap:10px;max-width:40em">
        <label>Project name<input name="name" required maxlength={80} value={idea.text.slice(0, 60)} /></label>
        <label>1. Which live project is this more valuable than?<select name="more_valuable_than" required><option value="">Pick one</option>{live.map(p => <option value={p.id}>{p.name} ({p.stage})</option>)}</select></label>
        <label>2. What gets paused? (paused now, in the same step)<select name="pause_project" required><option value="">Pick one</option>{pausable.map(p => <option value={p.id}>{p.name} ({p.stage})</option>)}</select></label>
        <label>Money weight (1–5)<select name="weight">{[1, 2, 3, 4, 5].map(n => <option value={String(n)} selected={n === 2}>{n}</option>)}</select></label>
        <button>Promote and pause</button>
      </form>}
  </div>;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slugify = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'idea';

/**
 * Add a promoted idea as a `planned` project and pause the named project, in one yaml write.
 * Returns the new yaml text; throws with a plain message when the gate is not satisfied.
 */
export function promoteIdea(yamlText: string, idea: { id: number; text: string }, input: { name: string; more_valuable_than: string; pause_project: string; weight: number }): { yaml: string; projectId: string } {
  const portfolio = loadPortfolio(yamlText);
  const beat = portfolio.projects.find(p => p.id === input.more_valuable_than);
  if (!beat || !['live', 'earning'].includes(beat.stage)) throw new Error('Pick the live or earning project this idea is more valuable than.');
  const pause = portfolio.projects.find(p => p.id === input.pause_project);
  if (!pause || !(activeStages as readonly string[]).includes(pause.stage)) throw new Error('Pick an active project to pause.');
  if (!input.name) throw new Error('A project name is required.');
  const ids = new Set(portfolio.projects.map(p => p.id));
  let id = slugify(input.name);
  for (let n = 2; ids.has(id); n++) id = `${slugify(input.name)}-${n}`;
  const paused = setProjectStatus(yamlText, pause.id, 'paused', `Paused for idea: ${input.name}`);
  const doc = parseDocument(paused);
  doc.addIn(['projects'], doc.createNode({
    id, name: redact(input.name), stage: 'planned', market: 'unknown', kind: 'unknown', money: { model: 'unknown', weight: input.weight },
    repos: [], domains: [], notes: redact(`Promoted from idea #${idea.id}: ${idea.text}. More valuable than ${beat.name}; paused ${pause.name}.`).slice(0, 1000),
  }));
  const output = doc.toString();
  loadPortfolio(output);
  return { yaml: output, projectId: id };
}

export interface RhythmRouteDeps { db: DB; ai: AiDeps; timeZone: string; now: () => Date; render: Render; readPortfolio: () => string; writePortfolio: (text: string) => void }

export function registerRhythmRoutes(app: Hono, deps: RhythmRouteDeps) {
  const { db } = deps;
  const projectsIn = (stages: readonly string[]) => db.prepare(`SELECT id,name,stage FROM projects WHERE stage IN (${stages.map(() => '?').join(',')}) ORDER BY name`).all(...stages) as ProjectOption[];
  const idea = (id: number) => db.prepare("SELECT * FROM ideas WHERE id=? AND status='parked'").get(id) as IdeaRow | undefined;
  const gate = (i: IdeaRow, error?: string) => deps.render('Promote idea', <PromoteGate idea={i} live={projectsIn(['live', 'earning'])} pausable={projectsIn(activeStages)} error={error} />);

  app.get('/review', c => {
    const week = c.req.query('week');
    const review = (week ? db.prepare('SELECT * FROM reviews WHERE week=?').get(week) : db.prepare('SELECT * FROM reviews ORDER BY week DESC LIMIT 1').get()) as StoredReview | undefined;
    if (week && !review) return c.text('No review for that week', 404);
    const archive = db.prepare('SELECT week, headline FROM reviews ORDER BY week DESC LIMIT 60').all() as { week: string; headline: string }[];
    return c.html(deps.render('Weekly review', <ReviewPage review={review ?? null} archive={archive} />));
  });
  app.post('/review/generate', async c => {
    await generateReview(db, deps.ai, deps.now(), deps.timeZone);
    return c.redirect('/review', 303);
  });

  app.get('/ideas', c => c.html(deps.render('Ideas', <IdeasPage
    parked={db.prepare("SELECT * FROM ideas WHERE status='parked' ORDER BY created_at DESC").all() as IdeaRow[]}
    promoted={db.prepare("SELECT * FROM ideas WHERE status='promoted' ORDER BY created_at DESC LIMIT 20").all() as IdeaRow[]} />)));
  app.post('/ideas', async c => {
    const t = text((await c.req.parseBody()).text, 2000);
    if (!t) return c.text('Nothing to park', 400);
    db.prepare("INSERT INTO ideas(text,created_at,status) VALUES (?,?,'parked')").run(t, deps.now().toISOString());
    return c.redirect('/ideas', 303);
  });
  app.post('/ideas/:id/drop', c => {
    const i = idea(Number(c.req.param('id')));
    if (!i) return c.text('Idea not found', 404);
    db.prepare("UPDATE ideas SET status='dropped' WHERE id=?").run(i.id);
    return c.redirect('/ideas', 303);
  });
  app.get('/ideas/:id/promote', c => {
    const i = idea(Number(c.req.param('id')));
    return i ? c.html(gate(i)) : c.text('Idea not found', 404);
  });
  app.post('/ideas/:id/promote', async c => {
    const i = idea(Number(c.req.param('id')));
    if (!i) return c.text('Idea not found', 404);
    const body = await c.req.parseBody(), weight = Number(body.weight ?? 2);
    const input = { name: text(body.name, 80), more_valuable_than: text(body.more_valuable_than, 100), pause_project: text(body.pause_project, 100), weight: [1, 2, 3, 4, 5].includes(weight) ? weight : 2 };
    let result: ReturnType<typeof promoteIdea>;
    try { result = promoteIdea(deps.readPortfolio(), i, input); }
    catch (error) { return c.html(await gate(i, redact(error instanceof Error ? error.message : 'Promotion failed')), 400); }
    deps.writePortfolio(result.yaml);
    db.prepare("UPDATE ideas SET status='promoted', gate_more_valuable_than=?, gate_pause_project=? WHERE id=?").run(input.more_valuable_than, input.pause_project, i.id);
    return c.redirect(`/project/${encodeURIComponent(result.projectId)}`, 303);
  });
}
