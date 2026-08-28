import type { Stack } from '@/lib/queries';
import type { SessionState } from '@/lib/nudge/ladder';
import { AutoSubmitForm } from './AutoSubmitForm';
import { updateSessionState } from '../actions';

export interface OneThingRepo {
  name: string;
  pct: number;
  minutes: number;
  stack: Stack | null;
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

/** The runbook generator is S2's job (plan.md §6 S1) — this is a stub from what O1's scan already stored. */
function RunbookStub({ stack }: { stack: Stack | null }) {
  if (!stack) {
    return <p>No stack metadata yet — the next deep scan picks this repo up, or run one manually.</p>;
  }
  return (
    <div className="runbook">
      <h4>What&apos;s known so far</h4>
      <ul>
        {stack.package_name && <li>package: <code>{stack.package_name}</code></li>}
        {stack.engine && <li>engine: <code>{stack.engine}</code>{stack.dialect ? ` (${stack.dialect})` : ''}</li>}
        {stack.package_manager && <li>package manager: <code>{stack.package_manager}</code></li>}
        <li>migrations: {stack.migrations}</li>
        {stack.env_session.length > 0 && (
          <li>env vars to set: {stack.env_session.join(', ')}</li>
        )}
      </ul>
      <p>The step-by-step runbook (exact commands, verify step) lands in phase S2 — this is O1&apos;s stored stack data only.</p>
    </div>
  );
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
              <span className="pct">{repo.pct}% · {repo.minutes} min</span>
            </summary>
            <RunbookStub stack={repo.stack} />
          </details>
        ))}
      </div>
    </section>
  );
}
