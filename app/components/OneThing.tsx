import type { Stack } from '@/lib/queries';
import type { SessionState } from '@/lib/nudge/ladder';
import { AutoSubmitForm } from './AutoSubmitForm';
import { ChatPanel } from './ChatPanel';
import { updateSessionState } from '../actions';

export interface OneThingRepo {
  id: number;
  name: string;
  pct: number;
  minutes: number;
  stack: Stack | null;
  /** Pre-rendered by page.tsx (lib/runbook.ts + lib/markdown.ts) — this component only displays it. */
  runbookHtml: string | null;
}

export type OneThingData =
  | {
      kind: 'batch' | 'shrunk';
      headline: string;
      why: string;
      minutes: number;
      batchKey: string | null;
      repos: OneThingRepo[];
    }
  | { kind: 'question'; headline: string; why: string; repos: string[] }
  | null;

/**
 * The real runbook (plan.md §6 S2), ported from `src/runbook.js` +
 * `templates/runbook-*.md` (lib/runbook.ts, lib/markdown.ts) and rendered
 * server-side in page.tsx — this component only displays the result. A repo
 * with no `stacks` row yet, or a render that failed and degraded to `null`
 * (plan.md §4.5), falls back to the same message.
 */
function Runbook({ stack, html }: { stack: Stack | null; html: string | null }) {
  if (!stack || !html) {
    return <p>No stack metadata yet — the next deep scan picks this repo up, or run one manually.</p>;
  }
  // Safe: `html` is this app's own generated runbook markdown, run through
  // lib/markdown.ts (which escapes everything first) — never user input.
  return <div className="runbook" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function OneThing({ data, session }: { data: OneThingData; session: SessionState }) {
  if (!data) {
    return (
      <section>
        <div className="eyebrow"><b>Today&apos;s one thing</b></div>
        <div className="onething quiet">
          <h2>Nothing prepped right now</h2>
          <p className="why">No owner-blocked DB session is waiting. Check the launch queue below.</p>
        </div>
      </section>
    );
  }

  if (data.kind === 'question') {
    return (
      <section>
        <div className="eyebrow"><b>Today&apos;s one thing</b></div>
        <div className="onething quiet">
          <h2>{data.headline}</h2>
          <p className="why">{data.why}</p>
          <p className="note">
            No push today — this repo is quiet for a week. Clearing its blocker below answers the question.
          </p>
        </div>
      </section>
    );
  }

  const batchRepoNames = data.repos.map((r) => r.name).join(',');

  return (
    <section>
      <div className="eyebrow"><b>Today&apos;s one thing</b><em>{data.minutes} min</em></div>
      <div className="onething">
        <h2>{data.headline}</h2>
        <p className="why">{data.why}</p>

        <AutoSubmitForm action={updateSessionState} className="acts">
          <input type="hidden" name="batch" value={batchRepoNames} />
          <input type="hidden" name="batch_key" value={data.batchKey ?? ''} />
          <label className="act">
            <input type="checkbox" name="booked" defaultChecked={!!session.booked} />
            Booked
            <input className="when" type="text" name="when" placeholder="when?" defaultValue={session.when ?? ''} />
          </label>
          <label className="act">
            <input type="checkbox" name="done" defaultChecked={!!session.done} />
            Done — all of it
          </label>
        </AutoSubmitForm>

        {data.repos.map((repo) => (
          <details className="repo" key={repo.name}>
            <summary>
              <span className="repo-name">{repo.name}</span>
              <span className="pct" style={{ '--pct': repo.pct } as React.CSSProperties}>{repo.pct}% · {repo.minutes} min</span>
            </summary>
            <Runbook stack={repo.stack} html={repo.runbookHtml} />
            <ChatPanel repoId={repo.id} repoName={repo.name} />
          </details>
        ))}
      </div>
    </section>
  );
}
