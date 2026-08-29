import type { ScoredRepo } from '@/lib/score';

/** DESIGN.md §2.4 — read-only, proof the portfolio keeps moving. */
export function AgentLane({ lane }: { lane: ScoredRepo[] }) {
  return (
    <section>
      <div className="eyebrow"><b>Agent lane</b><em>read-only</em></div>
      <p className="note agent-note">
        Repos an agent can push without you. Nothing to do here — it is the proof that the portfolio keeps
        moving while you sit the 20-minute session.
      </p>
      {lane.length === 0 && <p className="note">Nothing agent-drivable right now.</p>}
      <ul className="readonly">
        {lane.map(({ repo }) => (
          <li key={repo.name}>
            <span className="repo-name">{repo.name}</span>
            <span className="pct" style={{ '--pct': repo.pct } as React.CSSProperties}>{repo.pct}%</span>
            <span className="meta">
              {repo.merged_prs_30d > 0 && <span className="tag good">{repo.merged_prs_30d} merged</span>}
              {repo.open_prs > 0 && <span className="tag">{repo.open_prs} open</span>}
              {repo.last_commit_at && <span>{repo.last_commit_at}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
