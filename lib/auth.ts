/**
 * auth.ts — single-owner authentication.
 *
 * Decision recorded in plan.md §9: a **stateless signed cookie**, not the
 * `auth_sessions` table plan.md §2 offered as the alternative. The cookie is
 * checked in middleware, which runs on the edge runtime where a Postgres
 * connection is not available — a server-side session table would force every
 * request through a Node-runtime lookup for no security gain, since there is
 * exactly one user and one secret.
 *
 * The cookie value is `<issuedAt>.<hmacSHA256(issuedAt, OWNER_SECRET)>`, signed
 * with Web Crypto so the identical code runs in middleware and in route
 * handlers.
 */

export const COOKIE_NAME = 'coachme_owner';
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days: a phone home-screen app

const encoder = new TextEncoder();

function ownerSecret(): string | null {
  const secret = process.env.OWNER_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish comparison: same length check plus a full-width XOR scan. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueCookieValue(now = Date.now()): Promise<string> {
  const secret = ownerSecret();
  if (!secret) throw new Error('OWNER_SECRET is not set — cannot issue an owner cookie.');
  const issuedAt = String(now);
  return `${issuedAt}.${await sign(issuedAt, secret)}`;
}

export async function isValidCookieValue(value: string | undefined | null, now = Date.now()): Promise<boolean> {
  const secret = ownerSecret();
  if (!secret || !value) return false;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  const issuedAt = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^\d+$/.test(issuedAt)) return false;
  const age = (now - Number(issuedAt)) / 1000;
  if (age < -60 || age > MAX_AGE_SECONDS) return false;
  return safeEqual(mac, await sign(issuedAt, secret));
}

/** Does this secret match the configured OWNER_SECRET? (the /login form check) */
export function isOwnerSecret(candidate: string): boolean {
  const secret = ownerSecret();
  return !!secret && safeEqual(candidate, secret);
}

export function ownerSecretConfigured(): boolean {
  return ownerSecret() !== null;
}

/**
 * Cron endpoints carry no owner cookie — Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` instead (plan.md §5 O1). They are
 * therefore excluded from the cookie middleware and gated here.
 *
 * With no CRON_SECRET set the endpoints refuse rather than run open to the
 * internet; the graceful-degradation rule (§4.5) applies to *missing data*,
 * never to an authentication check.
 */
export function isAuthorizedCron(request: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  return safeEqual(header, `Bearer ${secret}`);
}
