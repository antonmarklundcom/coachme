/**
 * proxy.ts — the owner gate.
 *
 * (Next 16 renamed the `middleware` convention to `proxy`; same request hook,
 * same edge runtime, so the cookie check stays stateless — see lib/auth.ts.)
 *
 * Every route requires the signed owner cookie except:
 *   /login          — where you get one
 *   /api/scan       — Vercel Cron carries no cookie; gated on CRON_SECRET
 *   /api/nudge      — same, added in phase O2
 *   /manifest.json, /sw.js, /icons/* — the PWA shell (O2)
 *   /robots.txt     — says nothing about the portfolio; redirecting it to
 *                     /login is what a crawler (and Lighthouse's SEO audit)
 *                     reads as a broken robots.txt, not a private one (S2)
 *
 * Blanket-gating the cron routes would 401 the coach's own heartbeat, which is
 * exactly the kind of quiet failure this app cannot afford.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, isValidCookieValue, ownerSecretConfigured } from '@/lib/auth';

const OPEN_PATHS = [
  '/login',
  '/api/scan',
  '/api/nudge',
  // The PWA shell. A browser fetches the manifest and its icons before the user
  // has any chance to log in — redirecting those to /login makes the app
  // uninstallable, and the files say nothing about the portfolio.
  '/manifest.json',
  '/sw.js',
  '/icons',
  '/robots.txt',
];

/**
 * Routes that must refuse rather than open when there is no owner gate to
 * enforce: /api/push/subscribe writes rows, /api/chat spends Anthropic tokens.
 */
const CLOSED_WITHOUT_SECRET = ['/api/push/subscribe', '/api/chat'];

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  if (!ownerSecretConfigured()) {
    // With no OWNER_SECRET there is no way to log in, so gating every page
    // would lock the app shut with no recovery path (O1's call; /login says so
    // explicitly). That argument is about pages a human can read and recover
    // from — it does not extend to an API that writes rows or spends money.
    // Those fail closed: a misconfigured deploy should lose a feature, not
    // hand the internet a writable endpoint and an Anthropic bill.
    if (CLOSED_WITHOUT_SECRET.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return NextResponse.json(
        { error: 'OWNER_SECRET is not configured, so this endpoint is disabled.' },
        { status: 503 }
      );
    }
    return NextResponse.next();
  }

  if (await isValidCookieValue(request.cookies.get(COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own static assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
