import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4000),
  host: z.literal('127.0.0.1').default('127.0.0.1'),
  owner_tz: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  local_roots: z.array(z.string()), github_owner: z.string().regex(/^[\w-]+$/),
  collectors: z.object({
    github: z.number().positive(), local: z.number().positive(),
    domains: z.number().positive().default(30), hostinger: z.number().positive().default(10),
    notes: z.number().positive().default(60), sessions: z.number().positive().default(30), crm: z.number().positive().default(60), gsc: z.number().positive().default(1440),
  }),
  // Telegram rhythm (PLAN.md §8), owner timezone. weekly_weekday: 0 = Sunday.
  notify: z.object({
    daily_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
    weekly_weekday: z.number().int().min(0).max(6).default(0),
    weekly_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:00'),
  }).default({ daily_at: '08:00', weekly_weekday: 0, weekly_at: '18:00' }),
  ai: z.object({
    daily_usd_cap: z.number().nonnegative(), model: z.string(),
    // USD per million tokens; used to enforce the daily cap
    prices: z.record(z.string(), z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() })).default({ 'claude-sonnet-5': { input: 2, output: 10 } }),
  }),
});
export type Config = z.infer<typeof configSchema>;
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}
export function loadConfig(root = process.cwd()): Config {
  const envPath = resolve(root, '.env.local');
  if (existsSync(envPath)) for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, 'utf8')))) process.env[key] = value;
  try { return configSchema.parse(parse(readFileSync(resolve(root, 'config.yaml'), 'utf8'))); }
  catch { throw new Error('Invalid config.yaml: host must be 127.0.0.1; check timezone, port, collector intervals and notify times (HH:MM)'); }
}
