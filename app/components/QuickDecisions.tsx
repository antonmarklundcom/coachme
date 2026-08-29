import type { Repo } from '@/lib/domain';
import type { Decision, VerifyItem } from '@/lib/queries';
import { AutoSubmitForm } from './AutoSubmitForm';
import { classifyBlocker, confirmVerifyItem, resolveDecisionAnswer } from '../actions';

/** DESIGN.md §2.3 — batched, recommended answers pre-filled, never a one-at-a-time drip. */
export function QuickDecisions({
  decisions,
  verify,
  classify,
}: {
  decisions: Decision[];
  verify: VerifyItem[];
  classify: Repo[];
}) {
  const pending = decisions.length + verify.length;

  return (
    <section>
      <div className="eyebrow">
        <b>Quick decisions</b>
        <em>{pending} pending</em>
      </div>
      <p className="note">Recommended answers are pre-filled. Scan, tick, correct at most one, done.</p>

      {verify.map((item) => (
        <AutoSubmitForm action={confirmVerifyItem} key={item.id} className="decision drift">
          <input type="hidden" name="id" value={item.id} />
          <h3>
            <span className="id">verify</span>
            {item.repo_name ?? 'unnamed repo'}
          </h3>
          <p className="rec">{item.verify_reason}</p>
          <p className="why">The scan and your tick disagree. Nothing was changed either way — you settle it.</p>
          <label className="act">
            <input type="checkbox" name="confirmed" />
            My tick was right — it really is done
          </label>
        </AutoSubmitForm>
      ))}

      {decisions.map((d) => (
        <AutoSubmitForm action={resolveDecisionAnswer} key={d.id} className="decision">
          <input type="hidden" name="id" value={d.id} />
          <input type="hidden" name="recommended" value={d.recommended ?? ''} />
          <h3>
            <span className="id">{d.id}</span>
            {d.question}
          </h3>
          {d.recommended && <p className="rec">{d.recommended}</p>}
          {d.why && <p className="why">{d.why}</p>}
          {d.needed_for && <span className="needed">needed for: {d.needed_for}</span>}
          <label className="act">
            <input type="checkbox" name="accept" />
            Accept
          </label>
          <input className="text" type="text" name="note" placeholder="or correct it here" />
        </AutoSubmitForm>
      ))}

      {classify.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: '0.6rem' }}>
            <b>D6 — classify the blockers</b>
            <em>{classify.length} repos</em>
          </div>
          <p className="note">
            One line each: what exactly is the next step you have to take? Until these are answered they rank
            below every known DB task.
          </p>
          <ul className="rows">
            {classify.map((repo) => (
              <li key={repo.name}>
                <AutoSubmitForm action={classifyBlocker} className="classify-row">
                  <input type="hidden" name="repo" value={repo.name} />
                  <div className="head">
                    <span className="repo-name">{repo.name}</span>
                    <span className="pct" style={{ '--pct': repo.pct } as React.CSSProperties}>{repo.pct}%</span>
                  </div>
                  <input
                    className="text"
                    type="text"
                    name="next_step"
                    placeholder="next owner step…"
                    defaultValue={repo.next_step ?? ''}
                  />
                </AutoSubmitForm>
              </li>
            ))}
          </ul>
        </>
      )}

      {pending === 0 && classify.length === 0 && <p className="note">Nothing pending.</p>}
    </section>
  );
}
