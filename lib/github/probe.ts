/**
 * github/probe.ts — does the token actually carry the D-F write scopes?
 *
 * Read-only, and separate from write.ts so that module's exported surface stays
 * exactly the three capabilities Decision D-F lists.
 *
 * The probe is deliberately cheap and indirect: GitHub does not expose "may I
 * write to this repo" for a fine-grained token without attempting a write, and
 * attempting one to find out is precisely the thing this app must not do. So it
 * asks two harmless questions — is there a token, and does it identify someone
 * — and records the answer in `settings.github_write_ok`. A token that turns
 * out to be read-only fails at the first real dispatch with
 * `GithubWriteUnavailable`, which the dispatcher reports and downgrades to the
 * `copy` target; the flag then goes back to false on the next probe.
 */

import { getRepoInfo, getViewer, githubToken } from '../scan/github';
import { setGithubWriteOk } from '../queries';

export interface ProbeResult {
  ok: boolean;
  login: string | null;
  reason: string;
}

export async function probeWriteAccess(fullName?: string): Promise<ProbeResult> {
  if (!githubToken()) {
    return { ok: false, login: null, reason: 'GITHUB_TOKEN is not set' };
  }
  const viewer = await getViewer();
  if (!viewer) {
    return { ok: false, login: null, reason: 'the token did not authenticate (GET /user failed)' };
  }
  if (fullName) {
    const info = await getRepoInfo(fullName);
    if (!info) {
      return { ok: false, login: viewer.login, reason: `the token cannot see ${fullName}` };
    }
  }
  return { ok: true, login: viewer.login, reason: `authenticated as ${viewer.login}` };
}

/** Probe and persist. Called by the scan and by the dispatch route's fallback. */
export async function refreshWriteAccess(fullName?: string): Promise<ProbeResult> {
  const result = await probeWriteAccess(fullName);
  await setGithubWriteOk(result.ok);
  return result;
}
