/**
 * Web Push: the parts that must hold without a browser in the room.
 *
 * Delivery itself is proven end to end against a real push service stand-in and
 * a real Chromium service worker (plan.md §9). These pin the degradation rules
 * and the shape of the PWA shell, which are what quietly rot otherwise.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pushConfigured, vapidKeys } from '../lib/push';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const manifest = JSON.parse(read('public/manifest.json'));
const sw = read('public/sw.js');

const saved = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
afterEach(() => {
  process.env.VAPID_PUBLIC_KEY = saved.pub;
  process.env.VAPID_PRIVATE_KEY = saved.priv;
});

describe('degrading without VAPID keys (plan.md §4.5)', () => {
  it('reports push unconfigured rather than throwing', () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    expect(vapidKeys()).toBeNull();
    expect(pushConfigured()).toBe(false);
  });

  it('needs both halves of the pair — half a keypair is not configured', () => {
    process.env.VAPID_PUBLIC_KEY = 'public';
    delete process.env.VAPID_PRIVATE_KEY;
    expect(pushConfigured()).toBe(false);
  });
});

describe('no secret is ever generated into the repo', () => {
  it('generates the keypair to stdout only, never to a file', () => {
    const script = read('scripts/vapid.ts');
    expect(script).toMatch(/generateVAPIDKeys/);
    expect(script).not.toMatch(/writeFileSync|appendFileSync/);
  });

  it('documents both keys in .env.example, with no value', () => {
    const example = read('.env.example');
    expect(example).toMatch(/^VAPID_PUBLIC_KEY=$/m);
    expect(example).toMatch(/^VAPID_PRIVATE_KEY=$/m);
  });
});

describe('the PWA shell', () => {
  it('declares what Chrome needs to offer an install', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  });

  it('ships every icon the manifest promises', () => {
    for (const icon of manifest.icons as { src: string }[]) {
      const bytes = readFileSync(join(process.cwd(), 'public', icon.src));
      expect(bytes.length).toBeGreaterThan(200);
      // PNG magic — a placeholder or an HTML error page would fail here.
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  });

  it('handles push and notificationclick, and has a fetch handler for installability', () => {
    expect(sw).toMatch(/addEventListener\(\s*'push'/);
    expect(sw).toMatch(/addEventListener\(\s*'notificationclick'/);
    expect(sw).toMatch(/addEventListener\(\s*'fetch'/);
  });

  it('caches only the static shell, never a page', () => {
    // A cached dashboard would show yesterday's "Today's One Thing", and every
    // page here is personal state behind the owner gate.
    const shell = /const SHELL = \[([\s\S]*?)\]/.exec(sw)?.[1] ?? '';
    expect(shell).toMatch(/manifest\.json/);
    expect(shell).toMatch(/icons/);
    expect(shell).not.toMatch(/['"]\/['"]/);
  });
});

describe('failure handling', () => {
  it('guards the prune, so one dead subscription cannot fail the whole run', () => {
    // The nudge row is already written by the time push is attempted, so an
    // exception here would 500 a run that can never be retried today.
    const push = read('lib/push.ts');
    const catchBlock = push.slice(push.indexOf('} catch (err)'));
    const prune = catchBlock.slice(catchBlock.indexOf('deletePushSubscription'));
    expect(catchBlock.slice(0, catchBlock.indexOf('deletePushSubscription'))).toMatch(/try \{/);
    expect(prune).toMatch(/catch \(pruneErr\)/);
  });

  it('never lets a single failed endpoint reject the whole batch', () => {
    // Every per-subscription body is wrapped; Promise.all only sees fulfilled
    // promises, so `sent`/`failed`/`pruned` always add up to the subscriptions.
    const push = read('lib/push.ts');
    expect(push).toMatch(/await Promise\.all\(/);
    expect(push).toMatch(/} catch \(err\) \{/);
  });
});

describe('a dry run must not consume the day', () => {
  it('writes no nudge row and sends nothing', () => {
    // Recording a dry run would make `decidedOn` true and the real cron four
    // hours later would find the day answered and deliver nothing. A preview
    // that silently cancels the actual nudge is not a preview.
    const run = read('lib/nudge/run.ts');
    const guard = run.indexOf('if (opts.dryRun)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(run.indexOf('await recordNudge('));
    expect(run.slice(guard, run.indexOf('await recordNudge('))).toMatch(/return \{/);
  });
});

describe('the cron budget (plan.md §1: Vercel Hobby allows exactly two)', () => {
  const vercel = JSON.parse(read('vercel.json'));

  it('runs exactly two cron jobs', () => {
    expect(vercel.crons).toHaveLength(2);
  });

  it('nudges daily at 08:00 America/Asunción', () => {
    const nudge = vercel.crons.find((c: { path: string }) => c.path === '/api/nudge');
    expect(nudge.schedule).toBe('0 11 * * *'); // Asunción is permanently UTC-3
  });

  it('scans at least three hours before the nudge, so state is fresh', () => {
    // Hobby cron timing has up to an hour of slop, so the gap has to be real.
    const scan = vercel.crons.find((c: { path: string }) => c.path === '/api/scan');
    const hourOf = (s: string) => Number(s.split(' ')[1]);
    expect(hourOf(scan.schedule)).toBeLessThanOrEqual(hourOf('0 11 * * *') - 3);
  });
});
