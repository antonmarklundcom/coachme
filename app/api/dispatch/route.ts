/**
 * /api/dispatch — hand one approved work item to Claude Code, Codex, or Anton.
 *
 * Owner-gated (the cookie in proxy.ts) and, unlike the read-only endpoints,
 * listed in proxy.ts's CLOSED_WITHOUT_SECRET: with no OWNER_SECRET there is no
 * gate to enforce, and an ungated endpoint that commits files to 61 repositories
 * is not a degradation anyone would accept. It answers 503 instead.
 *
 * POST only. A GET that writes to someone else's repository would be a
 * link-prefetch away from a dispatch nobody asked for.
 */

import { NextResponse } from 'next/server';
import { DISPATCH_TARGETS, type DispatchTarget } from '@/lib/domain';
import { GithubWriteRefused } from '@/lib/github/write';
import { dispatch } from '@/lib/dispatch/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  let payload: { work_item_id?: unknown; target?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const id = Number(payload.work_item_id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'work_item_id must be a positive integer' }, { status: 400 });
  }
  if (!DISPATCH_TARGETS.includes(payload.target as DispatchTarget)) {
    return NextResponse.json(
      { error: `target must be one of: ${DISPATCH_TARGETS.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await dispatch(id, payload.target as DispatchTarget));
  } catch (err) {
    if (err instanceof GithubWriteRefused) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('[dispatch] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
