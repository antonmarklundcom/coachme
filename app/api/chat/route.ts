/**
 * /api/chat — ask a question about one repo. Advice only.
 *
 * Owner-gated by the cookie in proxy.ts (it is not in OPEN_PATHS), so it is
 * neither public nor cron-callable. It cannot write: see the three structural
 * reasons documented at the top of lib/chat.ts.
 *
 * Rate limit (plan.md §5 O2 leaves the shape to the implementer, recorded in
 * §9): a fixed-window counter in module memory, 20 questions per 10 minutes per
 * instance. This is a single-user personal tool behind an auth gate — the limit
 * exists to bound an accidental loop and a runaway API bill, not to fend off an
 * attacker, and an in-memory counter that resets when the lambda recycles is the
 * right size of solution for that. A shared counter would mean another table
 * and a round-trip on every question, for a user who is one person with a phone.
 */

import { NextResponse } from 'next/server';
import { GeminiUnavailable } from '@/lib/gemini';
import { MAX_QUESTION_LENGTH, answerRepoQuestion } from '@/lib/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
let windowStart = 0;
let windowCount = 0;

function overRateLimit(now = Date.now()): boolean {
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount > MAX_PER_WINDOW;
}

export async function POST(request: Request) {
  let payload: { repo_id?: unknown; question?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const repoId = Number(payload.repo_id);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return NextResponse.json({ error: 'repo_id must be a positive integer' }, { status: 400 });
  }

  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json(
      { error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` },
      { status: 400 }
    );
  }

  if (overRateLimit()) {
    return NextResponse.json(
      { error: `rate limit: ${MAX_PER_WINDOW} questions per 10 minutes` },
      { status: 429 }
    );
  }

  try {
    const answer = await answerRepoQuestion(repoId, question);
    if (!answer) return NextResponse.json({ error: 'no such repo' }, { status: 404 });
    return NextResponse.json({ ...answer, readonly: true });
  } catch (err) {
    if (err instanceof GeminiUnavailable) {
      return NextResponse.json(
        { error: 'the chat panel needs GEMINI_API_KEY — see .env.example' },
        { status: 503 }
      );
    }
    console.error('[chat] failed', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
