/**
 * /api/push/subscribe — store this browser's Web Push subscription.
 *
 * Owner-gated by the cookie in proxy.ts, unlike the cron routes: this is called
 * from the dashboard by a logged-in owner, so anyone who can reach it is
 * already inside the gate. Nothing here should ever be open — a writable
 * subscription endpoint is a spam channel.
 *
 *   GET  → the VAPID public key, so the client never hardcodes it
 *   POST → { endpoint, keys: { p256dh, auth } } from PushManager.subscribe()
 *   DELETE → { endpoint }, when the owner turns notifications off
 */

import { NextResponse } from 'next/server';
import { vapidKeys } from '@/lib/push';
import { deletePushSubscription, savePushSubscription } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const keys = vapidKeys();
  if (!keys) {
    // Degrade, don't crash (plan.md §4.5): the dashboard shows "push not
    // configured" instead of a broken subscribe button.
    return NextResponse.json({ configured: false, publicKey: null });
  }
  return NextResponse.json({ configured: true, publicKey: keys.publicKey });
}

export async function POST(request: Request) {
  let payload: { endpoint?: unknown; keys?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : null;
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return NextResponse.json({ error: 'endpoint must be an https URL' }, { status: 400 });
  }

  const raw = (payload.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof raw.p256dh === 'string' ? raw.p256dh : null;
  const auth = typeof raw.auth === 'string' ? raw.auth : null;
  if (!p256dh || !auth) {
    return NextResponse.json({ error: 'keys.p256dh and keys.auth are required' }, { status: 400 });
  }

  await savePushSubscription(endpoint, { p256dh, auth });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  let payload: { endpoint?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  if (typeof payload.endpoint !== 'string') {
    return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
  }
  await deletePushSubscription(payload.endpoint);
  return NextResponse.json({ ok: true });
}
