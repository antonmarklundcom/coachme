/**
 * /api/merge — squash-merge the pull request a dispatched item produced.
 *
 * Same gate as /api/dispatch: owner cookie, POST only, 503 with no OWNER_SECRET.
 * Every merge guard (branch prefix, open, conflict-free, green) lives in
 * lib/github/write.ts and is not re-implemented here — this route only turns a
 * work item id into a repo and a PR number.
 */

import { NextResponse } from 'next/server';
import { GithubWriteRefused, GithubWriteUnavailable } from '@/lib/github/write';
import { mergeWorkItem } from '@/lib/dispatch/merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  let payload: { work_item_id?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const id = Number(payload.work_item_id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'work_item_id must be a positive integer' }, { status: 400 });
  }

  try {
    return NextResponse.json(await mergeWorkItem(id));
  } catch (err) {
    if (err instanceof GithubWriteRefused) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof GithubWriteUnavailable) {
      return NextResponse.json(
        { error: `${err.message} — merging needs the fine-grained PAT from .env.example` },
        { status: 503 }
      );
    }
    console.error('[merge] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
