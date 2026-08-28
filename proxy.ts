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
 *
 * Blanket-gating the cron routes would 401 the coach's own heartbeat, which is
 * exactly the kind of quiet failure this app cannot afford.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, isValidCookieValue, ownerSecretConfigured } from '@/lib/auth';

const OPEN_PATHS = ['/login', '/api/scan', '/api/nudge', '/manifest.json', '/sw.js'];

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  // With no OWNER_SECRET configured there is no way to log in, so gating would
  // lock the app shut with no recovery path. /login says so explicitly.
  if (!ownerSecretConfigured()) return NextResponse.next();

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
