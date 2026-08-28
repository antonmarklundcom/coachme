import type { Repo } from '@/lib/domain';
import { AutoSubmitForm } from './AutoSubmitForm';
import { applyScope } from '../actions';

function dormantState(repo: Repo): string {
  if (repo.killed_at) return `killed ${repo.killed_at}`;
  if (repo.snoozed_until) return `snoozed until ${repo.snoozed_until}`;
  return '';
}

/** DESIGN.md §2.5 — the coach asks, the owner decides; nothing is archived on GitHub. */
export function ScopeReview({ due, dormant }: { due: Repo[]; dormant: Repo[] }) {
  return (
    <section>
      <div className="eyebrow"><b>Scope review</b><em>monthly</em></div>
      {due.length === 0 && (
        <p className="note">
          Nothing due. Repos land here once they have gone 30 days untouched — then it is keep, snooze 90
          days, or kill, and nothing is archived without your tick.
        </p>
      )}
      <ul className="rows">
        {due.map((repo) => (
          <li key={repo.name}>
            <AutoSubmitForm action={applyScope}>
              <input type="hidden" name="repo" value={repo.name} />
              <div className="scope-head">
                <span className="repo-name">{repo.name}</span>
                <span className="pct">{repo.pct}%</span>
                {repo.scope_review_proposed && (
                  <span className="tag">no answer twice — proposed: {repo.scope_review_proposed}</span>
                )}
              </div>
              <label className="row">
                <input type="radio" name="choice" value="keep" />
                Keep it
                <input className="text" type="text" name="note" placeholder="why, in one line" />
              </label>
              <label className="row">
                <input type="radio" name="choice" value="snooze" />
                Snooze 90 days
              </label>
              <label className="row">
                <input type="radio" name="choice" value="kill" />
                Kill — a flag here, nothing archived on GitHub
              </label>
            </AutoSubmitForm>
          </li>
        ))}
      </ul>

      {dormant.length > 0 && (
        <details className="dormant">
          <summary>{dormant.length} repos you have put down</summary>
          <ul className="readonly">
            {dormant.map((repo) => (
              <li key={repo.name}>
                <span className="repo-name">{repo.name}</span>
                <span className="meta">{dormantState(repo)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
