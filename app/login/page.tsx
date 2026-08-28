/**
 * /login — the only unauthenticated page.
 *
 * One field, one secret, one owner (plan.md §1: no user table, no OAuth, no
 * roles). A correct secret sets the signed cookie; middleware does the rest.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_NAME, MAX_AGE_SECONDS, isOwnerSecret, issueCookieValue, ownerSecretConfigured } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function login(formData: FormData) {
  'use server';
  const secret = String(formData.get('secret') ?? '');
  const next = String(formData.get('next') ?? '/') || '/';
  if (!isOwnerSecret(secret)) redirect(`/login?error=1${next === '/' ? '' : `&next=${encodeURIComponent(next)}`}`);

  const jar = await cookies();
  jar.set(COOKIE_NAME, await issueCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  // Only a same-site path: "//evil.example" also starts with "/" and would be
  // a protocol-relative redirect off this app.
  redirect(/^\/(?!\/)/.test(next) ? next : '/');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  return (
    <main className="auth">
      <form action={login}>
        <h1>coachme</h1>
        <p className="sub">Portfolio focus coach — owner only.</p>
        {!ownerSecretConfigured() && (
          <p className="warn">
            OWNER_SECRET is not set on this deployment, so there is nothing to log in against and every
            route is currently open. Set it in the Vercel project env (and in <code>.env.local</code> for
            local work), then redeploy.
          </p>
        )}
        <input type="hidden" name="next" value={next ?? '/'} />
        <label htmlFor="secret">Owner secret</label>
        <input id="secret" name="secret" type="password" autoComplete="current-password" autoFocus />
        {error && <p className="warn">That secret does not match. Try again.</p>}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
