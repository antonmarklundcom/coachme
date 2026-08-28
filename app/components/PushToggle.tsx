'use client';

/**
 * PushToggle — the button that turns the coach into something a phone buzzes for.
 *
 * The one place in the app that has to be a client component: registering a
 * service worker and asking for notification permission are browser gestures,
 * and the permission prompt only appears in response to a real click (Chrome
 * refuses a prompt the user did not ask for, and a refused prompt is remembered).
 *
 * It degrades quietly and says why, in every direction: no VAPID key configured,
 * no service-worker support, permission denied, insecure origin. A dead toggle
 * that does not explain itself is how push silently stops working for months.
 */

import { useCallback, useEffect, useState } from 'react';

type Status =
  | 'checking'
  | 'unsupported'
  | 'unconfigured'
  | 'denied'
  | 'off'
  | 'working'
  | 'on'
  | 'error';

const MESSAGE: Record<Status, string> = {
  checking: 'Checking notifications…',
  unsupported: 'This browser cannot receive Web Push. Open the app in Chrome or Safari 16.4+.',
  unconfigured: 'Push is not configured yet — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.',
  denied: 'Notifications are blocked for this site. Re-allow them in the browser’s site settings.',
  off: 'Notifications are off. The coach still decides daily; it just cannot reach you.',
  working: 'Subscribing…',
  on: 'Notifications are on. One push a day, at most — never on a Sunday.',
  error: 'Could not subscribe. Try again, or check the console.',
};

/** The VAPID public key travels as base64url and must reach PushManager as bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function PushToggle() {
  const [status, setStatus] = useState<Status>('checking');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (typeof window === 'undefined') return;
      // `isSecureContext` covers the localhost carve-out as well as https.
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) {
        if (!cancelled) setStatus('unsupported');
        return;
      }

      try {
        const res = await fetch('/api/push/subscribe');
        const { configured } = (await res.json()) as { configured: boolean };
        if (cancelled) return;
        if (!configured) {
          setStatus('unconfigured');
          return;
        }

        const registration = await navigator.serviceWorker.register('/sw.js');
        const existing = await registration.pushManager.getSubscription();
        if (cancelled) return;
        if (existing) setStatus('on');
        else setStatus(Notification.permission === 'denied' ? 'denied' : 'off');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setDetail(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    setStatus('working');
    setDetail(null);
    try {
      const keyRes = await fetch('/api/push/subscribe');
      const { publicKey } = (await keyRes.json()) as { publicKey: string | null };
      if (!publicKey) {
        setStatus('unconfigured');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off');
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Web Push requires this to be true in Chrome: every push must be shown.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
      setStatus('on');
    } catch (err) {
      setStatus('error');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const canSubscribe = status === 'off' || status === 'error';

  return (
    <section>
      <h2>Notifications</h2>
      <p className={status === 'on' ? 'sub' : 'warn'}>{MESSAGE[status]}</p>
      {detail && <p className="sub">{detail}</p>}
      {canSubscribe && (
        <button type="button" onClick={subscribe}>
          Turn on notifications
        </button>
      )}
    </section>
  );
}
