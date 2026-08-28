/**
 * /api/scan — the twice-weekly repo scan, fired by Vercel Cron (Mon/Thu 04:00
 * America/Asunción) and callable by hand.
 *
 * Cron requests carry no owner cookie, so this route is excluded from the
 * middleware cookie check and gated on `Authorization: Bearer $CRON_SECRET`
 * instead (Vercel sends that header automatically when CRON_SECRET is set).
 * Neither owner-gated nor open to the internet.
 */

import { NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/auth';
import { runScan, DEFAULT_CAP } from '@/lib/scan/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(request: Request, source: 'cron' | 'manual') {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const cap = Number(url.searchParams.get('cap') ?? DEFAULT_CAP);
  const force = (url.searchParams.get('force') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const result = await runScan({
      source,
      cap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, 20) : DEFAULT_CAP,
      force,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[scan] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** Vercel Cron issues GET. */
export async function GET(request: Request) {
  return handle(request, 'cron');
}

/** A hand-fired scan, e.g. `curl -XPOST -H "Authorization: Bearer $CRON_SECRET" .../api/scan?force=besikt`. */
export async function POST(request: Request) {
  return handle(request, 'manual');
}
