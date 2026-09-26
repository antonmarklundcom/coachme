import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { redact } from '../lib/redact.js';

/**
 * Search Console OAuth, installed-app flow with a loopback redirect to 127.0.0.1 and PKCE
 * (PLAN.md §5, collector 8). Read-only scope. The refresh token lives in data/secrets.json,
 * which is git-ignored and never shown in the UI or logs.
 */

export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type PostForm = (url: string, form: Record<string, string>) => Promise<{ status: number; json: unknown }>;
export const postForm: PostForm = async (url, form) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

export interface GscClient { clientId: string; clientSecret: string }
export function gscClient(env: NodeJS.ProcessEnv = process.env): GscClient | null {
  const clientId = env.GSC_CLIENT_ID?.trim(), clientSecret = env.GSC_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// --- secrets file -------------------------------------------------------------------------
export const SECRETS_PATH = resolve('data/secrets.json');
interface Secrets { gsc?: { refresh_token: string; connected_at: string } }
export function readSecrets(path = SECRETS_PATH): Secrets {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Secrets : {}; } catch { return {}; }
}
export function writeSecrets(secrets: Secrets, path = SECRETS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export const refreshToken = (path = SECRETS_PATH) => readSecrets(path).gsc?.refresh_token ?? null;

// --- flow ---------------------------------------------------------------------------------
export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') };
}
export function authUrl(client: GscClient, redirectUri: string, state: string, challenge: string) {
  return `${AUTH_URL}?${new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
}

const failure = (what: string, reply: { status: number; json: unknown }, client: GscClient) => {
  const j = reply.json as { error?: string; error_description?: string } | null;
  return new Error(redact(`Google ${what} failed (HTTP ${reply.status}): ${j?.error ?? 'no error code'}${j?.error_description ? ` - ${j.error_description}` : ''}`).split(client.clientSecret).join('[redacted]').slice(0, 300));
};

export async function exchangeCode(client: GscClient, code: string, verifier: string, redirectUri: string, post: PostForm = postForm): Promise<string> {
  const reply = await post(TOKEN_URL, { client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const token = (reply.json as { refresh_token?: string } | null)?.refresh_token;
  if (reply.status !== 200 || !token) throw failure('token exchange', reply, client);
  return token;
}

export async function accessToken(client: GscClient, refresh: string, post: PostForm = postForm): Promise<string> {
  const reply = await post(TOKEN_URL, { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
  const token = (reply.json as { access_token?: string } | null)?.access_token;
  if (reply.status !== 200 || !token) throw failure('token refresh', reply, client);
  return token;
}
