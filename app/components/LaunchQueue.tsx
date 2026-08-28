import type { ScoredRepo } from '@/lib/score';
import { AutoSubmitForm } from './AutoSubmitForm';
import { clearRepoBlocker } from '../actions';

/** DESIGN.md §2.2 — owner-blocked, ≥70%, ranked by leverage. */
export function LaunchQueue({ queue }: { queue: ScoredRepo[] }) {
  const minutes = queue.reduce((sum, e) => sum + e.minutes, 0);

  return (
    <section>
      <div className="eyebrow">
        <b>Launch queue</b>
        <em>{queue.length} repos · {minutes} min</em>
      </div>
      <p className="note">
        Owner-blocked and at least 70% finished, ranked by leverage. Tick a repo the moment its blocker is
        actually cleared — that is what moves it out of the queue.
      </p>
      {queue.length === 0 && <p className="note">Nothing owner-blocked at 70%+ right now.</p>}
      <ul className="rows">
        {queue.map(({ repo, minutes: repoMinutes, unblocks }) => {
          const stuck = repo.blocked_scans >= 3;
          return (
            <li key={repo.name}>
              <AutoSubmitForm action={clearRepoBlocker}>
                <input type="hidden" name="repo" value={repo.name} />
                <input type="hidden" name="blocker" value={repo.blocker} />
                <label className="row">
                  <input type="checkbox" name="cleared" />
                  <span className="repo-name">{repo.name}</span>
                  <span className="meta">
                    <span className="pct">{repo.pct}%</span>
                    <span className={`tag${repo.blocker === 'db-setup' ? ' db' : ''}`}>{repo.blocker}</span>
                    <span className="pct">{repoMinutes}m</span>
                  </span>
                  {repo.newly_blocked_at && (
                    <span className="flag">new — this landed on you since the last scan</span>
                  )}
                  {stuck && <span className="flag">stuck — blocked on you three scans running</span>}
                  {repo.next_step && <span className="unblocks">next: {repo.next_step}</span>}
                  {unblocks.length > 0 && <span className="unblocks">unblocks {unblocks.join(', ')}</span>}
                </label>
              </AutoSubmitForm>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
