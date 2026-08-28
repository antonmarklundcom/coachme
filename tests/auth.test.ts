/**
 * The owner gate. One user, one secret — but a broken cookie check would leave
 * the whole portfolio (which is Anton's business situation) open, so the
 * signing rules are pinned here.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_AGE_SECONDS,
  isAuthorizedCron,
  isOwnerSecret,
  isValidCookieValue,
  issueCookieValue,
  ownerSecretConfigured,
} from '../lib/auth';

const req = (authorization?: string) => ({
  headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? (authorization ?? null) : null) },
});

afterEach(() => {
  delete process.env.OWNER_SECRET;
  delete process.env.CRON_SECRET;
});

describe('owner cookie', () => {
  it('round-trips a freshly issued cookie', async () => {
    process.env.OWNER_SECRET = 'correct horse battery staple';
    const value = await issueCookieValue();
    expect(await isValidCookieValue(value)).toBe(true);
  });

  it('rejects a cookie signed with a different secret', async () => {
    process.env.OWNER_SECRET = 'first';
    const value = await issueCookieValue();
    process.env.OWNER_SECRET = 'second';
    expect(await isValidCookieValue(value)).toBe(false);
  });

  it('rejects a tampered timestamp, an empty value and junk', async () => {
    process.env.OWNER_SECRET = 'secret';
    const value = await issueCookieValue(1_000_000);
    const [, mac] = value.split('.');
    expect(await isValidCookieValue(`2000000.${mac}`)).toBe(false);
    expect(await isValidCookieValue('')).toBe(false);
    expect(await isValidCookieValue('nonsense')).toBe(false);
    expect(await isValidCookieValue(undefined)).toBe(false);
  });

  it('expires', async () => {
    process.env.OWNER_SECRET = 'secret';
    const now = Date.now();
    const value = await issueCookieValue(now);
    expect(await isValidCookieValue(value, now + (MAX_AGE_SECONDS - 60) * 1000)).toBe(true);
    expect(await isValidCookieValue(value, now + (MAX_AGE_SECONDS + 60) * 1000)).toBe(false);
  });

  it('validates nothing at all when no secret is configured', async () => {
    expect(ownerSecretConfigured()).toBe(false);
    expect(await isValidCookieValue('anything')).toBe(false);
    expect(isOwnerSecret('')).toBe(false);
  });
});

describe('cron gate', () => {
  it('accepts exactly the configured bearer token', () => {
    process.env.CRON_SECRET = 'cron-token';
    expect(isAuthorizedCron(req('Bearer cron-token'))).toBe(true);
    expect(isAuthorizedCron(req('Bearer wrong'))).toBe(false);
    expect(isAuthorizedCron(req('cron-token'))).toBe(false);
    expect(isAuthorizedCron(req())).toBe(false);
  });

  it('refuses every request when CRON_SECRET is unset — auth never degrades', () => {
    expect(isAuthorizedCron(req('Bearer anything'))).toBe(false);
    expect(isAuthorizedCron(req())).toBe(false);
  });
});
