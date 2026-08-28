/**
 * robots.txt (plan.md §6 S2, deploy polish): this is Anton's own private
 * dashboard, not a public site, so it should tell crawlers to stay out — and
 * it must actually be reachable to say so, or a crawler (and Lighthouse's SEO
 * audit) sees the owner-gate's /login redirect instead of a robots.txt.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('robots.txt', () => {
  it('disallows everything', () => {
    const robots = read('public/robots.txt');
    expect(robots).toMatch(/User-agent:\s*\*/);
    expect(robots).toMatch(/Disallow:\s*\/\s*$/m);
  });

  it('is open in the proxy, or every crawler request just gets redirected to /login', () => {
    const openPaths = /const OPEN_PATHS = \[([\s\S]*?)\];/.exec(read('proxy.ts'))?.[1] ?? '';
    expect(openPaths).toMatch(/\/robots\.txt/);
  });
});
