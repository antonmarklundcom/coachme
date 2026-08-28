/**
 * The dashboard (plan.md §6 S1) — DESIGN.md §2's six sections, reading only
 * through lib/queries.ts / lib/score.ts / lib/momentum.ts. No SQL here.
 */

import type { SessionState } from '@/lib/nudge/ladder';
import { isDormant, ownerMinutes } from '@/lib/domain';
import { safeTimeZone, today as ownerToday } from '@/lib/clock';
import { momentum } from '@/lib/momentum';
import { databaseUrl } from '@/lib/db';
import { getDecisions, getNudges, getOpenVerifyItems, getQueues, getSettings, getStack } from '@/lib/queries';
import { markdownToHtml } from '@/lib/markdown';
import { renderRunbook } from '@/lib/runbook';
import { PushToggle } from './components/PushToggle';
import { MomentumStrip } from './components/MomentumStrip';
import { OneThing, type OneThingData, type OneThingRepo } from './components/OneThing';
import { LaunchQueue } from './components/LaunchQueue';
import { QuickDecisions } from './components/QuickDecisions';
import { AgentLane } from './components/AgentLane';
import { ScopeReview } from './components/ScopeReview';

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

  const settings = await getSettings();
  const tz = safeTimeZone(settings.owner_timezone);
  const today = ownerToday(tz);

  const [{ repos, queue, lane, batches }, verify, decisions, nudges] = await Promise.all([
    getQueues({ date: today }),
    getOpenVerifyItems(),
    getDecisions('pending'),
    getNudges(),
  ]);

  const byName = new Map(repos.map((r) => [r.name, r]));
  const top = batches[0];
  const todaysNudge = nudges.find((n) => n.local_date === today);
  const session = (settings.session_state ?? {}) as SessionState;

  async function repoDetails(names: string[], minutesOverride?: number): Promise<OneThingRepo[]> {
    return Promise.all(
      names
        .map((name) => byName.get(name))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map(async (r) => {
          const stack = await getStack(r.id);
          return {
            id: r.id,
            name: r.name,
            pct: r.pct,
            minutes: minutesOverride ?? ownerMinutes(r),
            stack,
            runbookHtml: stack ? runbookHtmlFor(r.name, stack, r.pct, r.tier) : null,
          };
        })
    );
  }

  /**
   * Never let a bad runbook render take the whole dashboard down with it — a
   * malformed stacks row (or, worst case, assertNoSecrets catching something
   * it should) degrades to the stub, same as no stack at all (plan.md §4.5).
   */
  function runbookHtmlFor(
    name: string,
    stack: NonNullable<Awaited<ReturnType<typeof getStack>>>,
    pct: number,
    tier: string
  ): string | null {
    try {
      return markdownToHtml(renderRunbook(name, stack, { pct, tier }));
    } catch (err) {
      console.error(`[runbook] failed to render for ${name}`, err);
      return null;
    }
  }

  let oneThing: OneThingData = null;
  if (todaysNudge?.type === 'question') {
    oneThing = { kind: 'question', headline: todaysNudge.title ?? '', why: todaysNudge.body ?? '', repos: todaysNudge.repo_names };
  } else if (todaysNudge?.type === 'shrunk') {
    oneThing = {
      kind: 'shrunk',
      headline: todaysNudge.title ?? '',
      why: todaysNudge.body ?? '',
      minutes: 5,
      batchKey: null,
      repos: await repoDetails(todaysNudge.repo_names, 5),
    };
  } else if (top) {
    const plural = top.repos.length === 1 ? '' : 'es';
    oneThing = {
      kind: 'batch',
      headline: `${top.minutes} min unblocks ${top.repos.length} launch${plural}: ${top.repos.join(', ')}`,
      why:
        top.repos.length > 1
          ? 'Same Hostinger account for all of them — one sitting, several launches.'
          : 'Everything is prepped — this is the cheapest launch on the board.',
      minutes: top.minutes,
      batchKey: top.key,
      repos: await repoDetails(top.repos),
    };
  }

  const classify = repos.filter((r) => r.blocker === 'owner-setup-unclassified' && !isDormant(r, today));
  const scopeDue = repos.filter((r) => r.scope_review_due && !r.kept_at && !isDormant(r, today));
  const dormant = repos.filter((r) => isDormant(r, today));
  const strip = momentum(repos, nudges, { date: today, baselineMinutes: settings.hpanel_baseline_minutes });

  return (
    <main className="page">
      <header className="masthead">
        <h1>coachme</h1>
        <p>One prepped session a day. Everything else on this page is context.</p>
        <span className="stamp">timezone {tz} · today {today}</span>
      </header>

      <MomentumStrip momentum={strip} />

      <OneThing data={oneThing} session={session} />

      <LaunchQueue queue={queue} />

      <QuickDecisions decisions={decisions} verify={verify} classify={classify} />

      <AgentLane lane={lane} />

      <ScopeReview due={scopeDue} dormant={dormant} />

      <PushToggle />

      <footer>
        <span>Every tick here writes straight to the database — this page is a live view of it, not a copy.</span>
        <span>No credentials on this page, ever. Runbooks use placeholders — real values stay in your password manager.</span>
        <span>{strip.owner_minutes_total} owner-minutes of blockers across the whole portfolio.</span>
      </footer>
    </main>
  );
}
