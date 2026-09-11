/**
 * scan/github.ts — the only GitHub access this app has.
 *
 * The old scan ran inside a Claude Code session and could clone a repo. This
 * one runs in a serverless function, so everything it knows comes from the REST
 * API: a cheap listing, a handful of file contents, recent commits and PRs.
 *
 * Missing GITHUB_TOKEN is not fatal (plan.md §4.5): unauthenticated requests
 * still read public repos, just at 60/hour, and the caller logs the degradation.
 */

const API = 'https://api.github.com';

export function githubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? null;
}

async function gh<T>(path: string, { raw = false }: { raw?: boolean } = {}): Promise<T | null> {
  const token = githubToken();
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'coachme-scan',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status} ${res.statusText}`);
  return (raw ? ((await res.text()) as unknown as T) : ((await res.json()) as T));
}

export interface RemoteRepo {
  name: string;
  full_name: string;
  pushed_at: string;
  archived: boolean;
  default_branch: string;
  homepage: string | null;
}

/** The cheap listing (SCAN.md step 2): one page per 100 repos, sorted by push. */
export async function listOwnerRepos(owner: string): Promise<RemoteRepo[]> {
  const out: RemoteRepo[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh<RemoteRepo[]>(`/users/${owner}/repos?per_page=100&sort=pushed&page=${page}`);
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * One repo's listing fields. The fallback for environments where the
 * owner-wide listing is unavailable (a token scoped to individual repos, or a
 * proxy that blocks /users/:owner/repos) — SCAN.md's ladder already allows
 * per-repo probing instead of one listing, and 53 cheap calls twice a week is
 * an acceptable price for the scan working at all.
 */
export async function getRepoInfo(fullName: string): Promise<RemoteRepo | null> {
  return gh<RemoteRepo>(`/repos/${fullName}`);
}

/** File contents as text, or null when the file does not exist. */
export async function getFile(fullName: string, path: string): Promise<string | null> {
  return gh<string>(`/repos/${fullName}/contents/${encodeURI(path)}`, { raw: true });
}

/** Directory listing — file names only, which is all the stack scan needs. */
export async function listDir(fullName: string, path = ''): Promise<string[]> {
  const entries = await gh<{ name: string; type: string }[]>(
    `/repos/${fullName}/contents/${encodeURI(path)}`
  ).catch(() => null);
  return Array.isArray(entries) ? entries.map((e) => e.name) : [];
}

export interface CommitInfo {
  sha: string;
  date: string;
  message: string;
}

export async function listCommits(fullName: string, limit = 20): Promise<CommitInfo[]> {
  const raw = await gh<
    { sha: string; commit: { committer: { date: string }; message: string } }[]
  >(`/repos/${fullName}/commits?per_page=${limit}`);
  return (raw ?? []).map((c) => ({
    sha: c.sha,
    date: c.commit.committer.date,
    message: c.commit.message.split('\n')[0],
  }));
}

export interface PullInfo {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  updated_at: string;
}

/** Open PRs, plus PRs merged in the last 30 days (DESIGN.md's agent-lane signal). */
export async function listPulls(fullName: string): Promise<{ open: PullInfo[]; mergedLast30d: PullInfo[] }> {
  const open = (await gh<PullInfo[]>(`/repos/${fullName}/pulls?state=open&per_page=30`)) ?? [];
  const recent = (await gh<PullInfo[]>(`/repos/${fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=30`)) ?? [];
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return {
    open,
    mergedLast30d: recent.filter((p) => p.merged_at && Date.parse(p.merged_at) >= cutoff),
  };
}

/** The document shortlist from SCAN.md step 4, in the same order. */
export const DOC_SHORTLIST = [
  'PLAN.md',
  'PROGRESS.md',
  'TASKS.md',
  'ROADMAP.md',
  'CLAUDE.md',
  'AGENTS.md',
  'README.md',
];

export async function fetchDocs(fullName: string, maxChars = 6000): Promise<{ path: string; text: string }[]> {
  const docs: { path: string; text: string }[] = [];
  for (const path of DOC_SHORTLIST) {
    const text = await getFile(fullName, path).catch(() => null);
    if (text) docs.push({ path, text: text.slice(0, maxChars) });
    if (docs.length >= 4) break; // enough context; the rest is repetition
  }
  return docs;
}

/**
 * The launch signal, and the one thing in the scan that is evidence rather than
 * judgement: a URL that answers. Never inferred (SCAN.md: `live_url_ok` is true
 * only if the scan actually fetched it).
 */
export async function checkLiveUrl(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------- what a dispatched PR did */

/**
 * The read half of PR tracking (Decision D-G) and of the merge guard (D-F).
 * All of it is GET; every write lives in lib/github/write.ts and nowhere else.
 */

export interface PullDetail extends PullInfo {
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  draft: boolean;
  merged: boolean;
  mergeable_state: string | null;
}

export async function getPull(fullName: string, number: number): Promise<PullDetail | null> {
  return gh<PullDetail>(`/repos/${fullName}/pulls/${number}`);
}

/** Open PRs with their head branch — what links a PR to a work item. */
export async function listOpenPullDetails(fullName: string): Promise<PullDetail[]> {
  return (await gh<PullDetail[]>(`/repos/${fullName}/pulls?state=open&per_page=50`)) ?? [];
}

/** Recently updated closed PRs, so a merge between two scans is not missed. */
export async function listClosedPullDetails(fullName: string): Promise<PullDetail[]> {
  return (
    (await gh<PullDetail[]>(`/repos/${fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=30`)) ?? []
  );
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CommitStatus {
  state: string;
  context: string;
}

/**
 * Both CI surfaces GitHub has: check runs (Actions) and commit statuses.
 *
 * `unknown` is the load-bearing field. An empty result and an unreachable
 * endpoint look identical once you flatten them to "no failing checks", and a
 * merge guard that reads a 404 as "nothing is failing" is not a guard at all —
 * so the two are kept apart here and `mergePull` refuses the unknown case.
 */
export async function getChecks(
  fullName: string,
  sha: string
): Promise<{ runs: CheckRun[]; statuses: CommitStatus[]; unknown: boolean }> {
  const [runs, combined] = await Promise.all([
    gh<{ check_runs: CheckRun[] }>(`/repos/${fullName}/commits/${sha}/check-runs?per_page=100`).catch(() => null),
    gh<{ statuses: CommitStatus[] }>(`/repos/${fullName}/commits/${sha}/status`).catch(() => null),
  ]);
  return {
    runs: runs?.check_runs ?? [],
    statuses: combined?.statuses ?? [],
    unknown: runs === null && combined === null,
  };
}

/** Does this branch exist? The signal that a dispatched agent has started. */
export async function branchExists(fullName: string, branch: string): Promise<boolean> {
  const ref = await gh<{ name: string }>(`/repos/${fullName}/branches/${encodeURIComponent(branch)}`).catch(
    () => null
  );
  return !!ref;
}

/** The blob SHA of an existing file, needed to UPDATE rather than create it. */
export async function getFileSha(fullName: string, path: string, ref?: string): Promise<string | null> {
  const meta = await gh<{ sha: string }>(
    `/repos/${fullName}/contents/${encodeURI(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
  ).catch(() => null);
  return meta?.sha ?? null;
}

/** Who the token belongs to — the read half of O4's write-access probe. */
export async function getViewer(): Promise<{ login: string } | null> {
  return gh<{ login: string }>('/user').catch(() => null);
}
