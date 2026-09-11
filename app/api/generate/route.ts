/**
 * /api/generate — propose work for one repo, on demand.
 *
 * The same generator the scan runs (lib/generate/run.ts), reachable from the
 * work desk's Generate button so Anton never has to wait for Thursday. Owner-
 * gated, POST only, 503 without OWNER_SECRET — it spends Anthropic tokens, which
 * is the same reason /api/chat fails closed.
 */

import { NextResponse } from 'next/server';
import { getRepo } from '@/lib/queries';
import { GeneratorUnavailable, generateForRepo } from '@/lib/generate/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  const name = new URL(request.url).searchParams.get('repo')?.trim();
  if (!name) {
    return NextResponse.json({ error: 'pass ?repo=<name>' }, { status: 400 });
  }

  const repo = await getRepo(name);
  if (!repo) return NextResponse.json({ error: `no repo named "${name}"` }, { status: 404 });

  try {
    return NextResponse.json(await generateForRepo(repo.id));
  } catch (err) {
    if (err instanceof GeneratorUnavailable) {
      return NextResponse.json(
        { error: 'the generator needs ANTHROPIC_API_KEY — see .env.example' },
        { status: 503 }
      );
    }
    console.error('[generate] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
