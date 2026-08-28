import type { MomentumStrip as MomentumData } from '@/lib/momentum';

/** DESIGN.md §2.6 — read-only, no writes here. */
export function MomentumStrip({ momentum }: { momentum: MomentumData }) {
  return (
    <div className="momentum">
      <div className="stats">
        <div className="stat">
          <b>{momentum.launches}</b>
          <span>launches / 30d</span>
        </div>
        <div className="stat">
          <b>{momentum.sessions}</b>
          <span>DB sessions done</span>
        </div>
        <div className="stat">
          <b>{momentum.streak}</b>
          <span>days, nothing dropped</span>
        </div>
      </div>
      <div className="burn">
        <div className="row">
          <span className="label">hPanel time left in the whole backlog</span>
          <span className="value">
            {momentum.remaining_h} h / {momentum.baseline_h} h
          </span>
        </div>
        <div className="meter">
          <i style={{ width: `${momentum.burned_pct}%` }} />
        </div>
      </div>
    </div>
  );
}
