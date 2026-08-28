/**
 * vapid.ts — generate the Web Push keypair, once.
 *
 *   npm run vapid
 *
 * Prints the pair to stdout for pasting into the Vercel project's environment
 * settings (and a local `.env.local`). It deliberately does NOT write a file:
 * plan.md §7 and the O2 prompt both require that no real secret ever lands in
 * the repo, and a script that writes one is a script that eventually commits one.
 *
 * Run it once and keep the output. Regenerating the pair invalidates every
 * subscription already stored in `push_subscriptions`, which means every device
 * silently stops receiving nudges until it re-subscribes.
 */

import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
Web Push VAPID keypair — paste into Vercel project env AND .env.local.
Never commit these. Regenerating them invalidates every existing subscription.

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}

The public key is also served to the browser by /api/push/subscribe (GET), so
the client never needs it hardcoded.
`);
