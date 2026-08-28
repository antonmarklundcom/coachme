/**
 * env.ts — load .env.local for the CLI scripts.
 *
 * Next loads .env.local itself; plain `tsx` does not. That exact gap is a
 * documented Hostinger-era trap (the nextjs-deploy-hostinger playbook), and it
 * bites identically here, so the scripts load it explicitly rather than relying
 * on the shell.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(files = ['.env.local', '.env']): void {
  for (const file of files) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key] !== undefined) continue;
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
      process.env[key] = value;
    }
  }
}
