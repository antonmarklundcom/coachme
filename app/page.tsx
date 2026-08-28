/**
 * The dashboard — a foundation-phase placeholder.
 *
 * Phase O1 builds state, not screens: this page exists to prove the gate, the
 * database and the scoring service all work end to end. The six real sections
 * of DESIGN.md §2 are phase S1's job, built on `getQueues()` and the rest of
 * lib/queries.ts rather than on SQL of their own.
 */

import { PushToggle } from './components/PushToggle';
import { databaseUrl } from '@/lib/db';
import { getQueues, getSettings, getOpenVerifyItems } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!databaseUrl()) {
    return (
      <main className="shell">
        <h1>coachme</h1>
        <p className="warn">
          DATABASE_URL is not set, so there is no state of record to show. Point it at the Neon database
          (see <code>.env.example</code>), run <code>npm run migrate &amp;&amp; npm run seed</code>, and reload.
        </p>
      </main>
    );
  }

  const [{ queue, batches, lane }, settings, verify] = await Promise.all([
    getQueues(),
    getSettings(),
    getOpenVerifyItems(),
  ]);
  const top = batches[0];

  return (
    <main className="shell">
      <h1>coachme</h1>
      <p className="sub">
        Foundation phase. {queue.length} owner-blocked repos at ≥70%, {lane.length} in the agent lane,
        timezone {settings.owner_timezone}.
      </p>

      {top && (
        <section>
          <h2>Today&apos;s one thing</h2>
          <p className="headline">
            {top.minutes} min unblocks {top.repos.length} launch{top.repos.length === 1 ? '' : 'es'}:{' '}
            {top.repos.join(', ')}
          </p>
        </section>
      )}

      <section>
        <h2>Launch queue</h2>
        <ol>
          {queue.slice(0, 10).map((entry) => (
            <li key={entry.repo.name}>
              <strong>{entry.repo.name}</strong> · {entry.repo.pct}% · {entry.repo.blocker} ·{' '}
              {entry.minutes} min · score {entry.total.toFixed(1)}
            </li>
          ))}
        </ol>
      </section>

      <PushToggle />

      {verify.length > 0 && (
        <section>
          <h2>Verify</h2>
          <ul>
            {verify.map((item) => (
              <li key={item.id}>{item.verify_reason}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
