/**
 * push.ts — Web Push delivery (plan.md §5 O2).
 *
 * This replaces "push via the Claude app": a real VAPID-signed Web Push to
 * every browser that has subscribed, so the coach can reach a phone's home
 * screen without an app store.
 *
 * The keypair is generated ONCE by `npm run vapid` and pasted into the Vercel
 * environment. It is never generated at runtime (a new key silently
 * invalidates every existing subscription) and never committed — plan.md §7
 * lists it as a human-set env var, and the phase prompt is explicit that no
 * real secret enters the repo.
 *
 * Degradation (plan.md §4.5): with no keys configured, the nudge is still
 * decided, recorded and visible on the dashboard — it just is not delivered to
 * a phone. Missing data makes the coach quieter; it never makes it crash.
 */

import webpush from 'web-push';
import { deletePushSubscription, getPushSubscriptions } from './queries';

/** The `mailto:` VAPID subject. Push services want a way to contact the sender. */
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:marklundfaktura@gmail.com';

export function vapidKeys(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

export function pushConfigured(): boolean {
  return vapidKeys() !== null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where the notification click lands. */
  url?: string;
  /** Collapse key: a second nudge replaces the first rather than stacking. */
  tag?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  pruned: number;
  skipped?: string;
}

/**
 * Send one payload to every stored subscription.
 *
 * A 404 or 410 from the push service is the browser saying the subscription is
 * gone for good (permission revoked, app uninstalled, endpoint rotated). Those
 * rows are deleted rather than retried forever — otherwise a dead phone would
 * make every future run look half-failed.
 */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  const keys = vapidKeys();
  if (!keys) {
    console.warn('[push] VAPID keys are not set — nudge recorded but not delivered');
    return { sent: 0, failed: 0, pruned: 0, skipped: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set' };
  }

  const subscriptions = await getPushSubscriptions();
  if (subscriptions.length === 0) {
    console.warn('[push] no subscriptions stored — nobody has accepted the permission prompt yet');
    return { sent: 0, failed: 0, pruned: 0, skipped: 'no push subscriptions' };
  }

  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  const body = JSON.stringify(payload);
  const result: PushResult = { sent: 0, failed: 0, pruned: 0 };

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          body,
          { TTL: 12 * 60 * 60 }
        );
        result.sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Guarded: this is the one database call inside the catch, and an
          // unguarded rejection here would reject the whole Promise.all —
          // losing the other subscriptions' results and 500-ing a run whose
          // nudge row is already written, so it can never be retried today.
          // A subscription that fails to delete is retried on the next push.
          try {
            await deletePushSubscription(sub.endpoint);
            result.pruned++;
          } catch (pruneErr) {
            result.failed++;
            console.error(`[push] could not prune a dead subscription: ${(pruneErr as Error).message}`);
          }
          return;
        }
        result.failed++;
        console.error(`[push] ${sub.endpoint.slice(0, 60)}… failed (${status ?? 'no status'})`);
      }
    })
  );

  return result;
}
