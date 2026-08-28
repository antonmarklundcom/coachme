/**
 * /api/nudge — the daily coaching decision, fired by Vercel Cron (08:00
 * America/Asunción, the answered D1 time) and callable by hand.
 *
 * Gated exactly like /api/scan: Cron carries no owner cookie, so this route is
 * excluded from the cookie check in proxy.ts and requires
 * `Authorization: Bearer $CRON_SECRET` instead. Neither owner-gated nor open to
 * the internet.
 *
 * This is the second and final cron in the Vercel Hobby budget (plan.md §1) —
 * do not add a third without upgrading the plan or multiplexing one endpoint.
 */

import { NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/auth';
import { runNudge } from '@/lib/nudge/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: Request, source: 'cron' | 'manual') {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Both are test affordances, and both are harmless: `date` replays the ladder
  // for another owner-local day, `dry` decides and records without delivering.
  const date = url.searchParams.get('date') ?? undefined;
  const dryRun = url.searchParams.get('dry') === '1';

  try {
    const result = await runNudge({
      source,
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      dryRun,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[nudge] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** Vercel Cron issues GET. */
export async function GET(request: Request) {
  return handle(request, 'cron');
}

/** A hand-fired run, e.g. `curl -XPOST -H "Authorization: Bearer $CRON_SECRET" .../api/nudge`. */
export async function POST(request: Request) {
  return handle(request, 'manual');
}
