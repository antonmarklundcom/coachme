import { redact } from '../../lib/redact.js';

export type Tool = 'claude' | 'codex';

/** What one session log reduces to. Raw text never leaves this module unredacted. */
export interface SessionFacts {
  tool: Tool;
  started_at: string | null;
  last_at: string | null;
  cwd: string | null;
  branch: string | null;
  title: string | null;             // Claude's generated session title, redacted
  last_request: string | null;      // last real user message, redacted, ≤ 200 chars
  last_assistant: string | null;    // last assistant text, redacted, ≤ 300 chars
  last_event: 'user' | 'assistant_text' | 'tool_call' | 'tool_result' | null;
  paths: Record<string, number>;    // C:\Claude 1\<dir> → times referenced in tool calls
  rel: Record<string, number>;      // folder names reached with cd / -C / workdir while in a root
  user_turns: number;
  tool_calls: number;
}

const clip = (text: string, max: number) => { const flat = redact(text).replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** Strip injected blocks (<system-reminder>, <command-name>, environment context …) from a user message. */
export function realUserText(text: string): string | null {
  const stripped = text.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').trim();
  if (!stripped || /^(Caveat:|\[Request interrupted|Base directory for this skill)/i.test(stripped)) return null;
  return stripped;
}

/** Every `<root>\<dir>` referenced in a string, counted by top-level folder under the root. */
export function countPaths(text: string, roots: string[], into: Record<string, number>) {
  for (const root of roots) {
    // Separators may be / or \ and are doubled inside JSON-encoded tool input.
    const escaped = root.split(/[\\/]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
    const re = new RegExp(`${escaped}[\\\\/]+([^\\\\/"'\\s:*?<>|]+)`, 'gi');
    for (const m of text.matchAll(re)) {
      const key = `${root}\\${m[1]}`.toLowerCase();
      into[key] = (into[key] ?? 0) + 1;
    }
  }
}

/** Folder names a command moves into: cd X, pushd X, Set-Location X, git -C X, --cwd X, "workdir":"X". */
export function countRelative(text: string, into: Record<string, number>) {
  const re = /(?:\b(?:cd|pushd|Set-Location|sl)\s+|\s-C\s+|--cwd[=\s]+|\\?"workdir\\?"\s*:\s*)\\?["']?([^"'\s;&|)]+)/gi;
  for (const m of text.matchAll(re)) {
    const first = m[1].split(/[\\/]+/).filter(Boolean)[0];
    if (!first || /^[a-z]:$/i.test(first) || first === '.' || first === '..' || first.startsWith('$') || first.startsWith('~')) continue;
    const name = first.toLowerCase();
    into[name] = (into[name] ?? 0) + 1;
  }
  // Relative paths used while sitting in a root: trabajo\src\x.ts, "comida-com-py/index.html".
  // Only names that turn out to be a checkout folder are ever used, so noise here is harmless.
  for (const m of text.matchAll(/(?:^|[\s"'(=,:])([A-Za-z0-9][\w.-]{1,60})(?:\\\\|\\|\/)[\w.-]/g)) {
    const name = m[1].toLowerCase();
    into[name] = (into[name] ?? 0) + 1;
  }
}

export class SessionReducer {
  facts: SessionFacts;
  constructor(tool: Tool, private roots: string[]) {
    this.facts = { tool, started_at: null, last_at: null, cwd: null, branch: null, title: null, last_request: null, last_assistant: null, last_event: null, paths: {}, rel: {}, user_turns: 0, tool_calls: 0 };
  }
  private stamp(ts: unknown) {
    if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) return;
    if (!this.facts.started_at || ts < this.facts.started_at) this.facts.started_at = ts;
    if (!this.facts.last_at || ts > this.facts.last_at) this.facts.last_at = ts;
  }
  private userText(text: string) {
    const real = realUserText(text);
    if (!real) return;
    this.facts.last_request = clip(real, 200); this.facts.user_turns++; this.facts.last_event = 'user';
  }
  private toolCall(input: string) { this.facts.tool_calls++; this.facts.last_event = 'tool_call'; countPaths(input, this.roots, this.facts.paths); countRelative(input, this.facts.rel); }

  /** Feed one parsed JSONL record. Unknown shapes are ignored. */
  add(o: any) {
    if (!o || typeof o !== 'object') return;
    if (this.facts.tool === 'claude') this.addClaude(o); else this.addCodex(o);
  }
  private addClaude(o: any) {
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') { this.facts.title = clip(o.customTitle, 80); return; }
    if (typeof o.cwd === 'string') this.facts.cwd ??= o.cwd;
    if (typeof o.gitBranch === 'string' && o.gitBranch) this.facts.branch = o.gitBranch;
    if (o.type !== 'user' && o.type !== 'assistant') return;
    if (o.isSidechain) return; // subagent traffic is not the owner's conversation
    this.stamp(o.timestamp);
    const content = o.message?.content;
    if (o.type === 'user') {
      if (o.isMeta) return;
      if (typeof content === 'string') return this.userText(content);
      if (!Array.isArray(content)) return;
      if (content.some((b: any) => b?.type === 'tool_result')) { this.facts.last_event = 'tool_result'; return; }
      const text = content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      if (text) this.userText(text);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) { this.facts.last_assistant = clip(b.text, 300); this.facts.last_event = 'assistant_text'; }
      else if (b?.type === 'tool_use') this.toolCall(JSON.stringify(b.input ?? {}));
    }
  }
  private addCodex(o: any) {
    this.stamp(o.timestamp);
    const p = o.payload;
    if (o.type === 'session_meta' && typeof p?.cwd === 'string') { this.facts.cwd ??= p.cwd; return; }
    if (o.type === 'turn_context' && typeof p?.cwd === 'string') { this.facts.cwd = p.cwd; return; }
    if (o.type !== 'response_item' || !p) return;
    if (p.type === 'message') {
      const text = (Array.isArray(p.content) ? p.content : []).filter((c: any) => typeof c?.text === 'string').map((c: any) => c.text).join('\n');
      if (p.role === 'user' && text) this.userText(text);
      else if (p.role === 'assistant' && text.trim()) { this.facts.last_assistant = clip(text, 300); this.facts.last_event = 'assistant_text'; }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      this.toolCall(String(p.arguments ?? p.input ?? JSON.stringify(p.action ?? {})));
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') this.facts.last_event = 'tool_result';
  }
}

export function parseSessionText(tool: Tool, text: string, roots: string[]): SessionFacts {
  const r = new SessionReducer(tool, roots);
  for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; try { r.add(JSON.parse(line)); } catch { /* torn last line while a session is writing */ } }
  return r.facts;
}

/**
 * A session ended mid-task when it stopped on a tool call or result, on an unanswered user
 * message, or on an assistant question. Sessions active in the last 30 minutes are not
 * judged yet. Heuristic, and labelled as one in the UI.
 */
export function endedMidTask(f: SessionFacts, now: Date): boolean {
  if (!f.last_at || now.getTime() - Date.parse(f.last_at) < 30 * 60_000) return false;
  if (f.user_turns === 0) return false;
  if (f.last_event === 'tool_call' || f.last_event === 'tool_result' || f.last_event === 'user') return true;
  return /\?\s*$/.test(f.last_assistant ?? '');
}

export interface Checkout { path: string; repo: string | null }
/**
 * Repo attribution (PLAN.md §5): cwd inside a checkout, else the most-referenced checkout in
 * tool calls, else a branch that belongs to exactly one repo, else unattributed.
 */
export function attribute(f: SessionFacts, checkouts: Checkout[], branchOwners: Map<string, string>): { repo: string | null; path: string | null; via: 'cwd' | 'paths' | 'branch' | null } {
  const norm = (p: string) => p.toLowerCase().replace(/[\\/]+/g, '\\').replace(/\\$/, '');
  const byPath = new Map(checkouts.map(c => [norm(c.path), c]));
  if (f.cwd) {
    const cwd = norm(f.cwd);
    const hit = [...byPath.entries()].filter(([p]) => cwd === p || cwd.startsWith(`${p}\\`)).sort((a, b) => b[0].length - a[0].length)[0];
    if (hit) return { repo: hit[1].repo ?? leaf(hit[1].path), path: hit[1].path, via: 'cwd' };
  }
  const ranked = Object.entries(f.paths).map(([p, n]) => [norm(p), n] as const).filter(([p]) => byPath.has(p)).sort((a, b) => b[1] - a[1]);
  if (ranked.length) { const c = byPath.get(ranked[0][0])!; return { repo: c.repo ?? leaf(c.path), path: c.path, via: 'paths' }; }
  const byName = new Map(checkouts.map(c => [leaf(c.path).toLowerCase(), c]));
  const rel = Object.entries(f.rel).filter(([n]) => byName.has(n)).sort((a, b) => b[1] - a[1]);
  if (rel.length) { const c = byName.get(rel[0][0])!; return { repo: c.repo ?? leaf(c.path), path: c.path, via: 'paths' }; }
  // Scratch and review folders named after a repo (trabajo-fixes, vendercrm-review-0926).
  const folders = [f.cwd ? leaf(f.cwd) : null, ...Object.entries(f.paths).sort((a, b) => b[1] - a[1]).map(([p]) => leaf(p))].filter((x): x is string => !!x);
  for (const folder of folders) {
    const name = folder.toLowerCase();
    const hit = checkouts.filter(c => c.repo && (name.startsWith(`${c.repo.toLowerCase()}-`) || name.startsWith(`${leaf(c.path).toLowerCase()}-`)))
      .sort((a, b) => b.repo!.length - a.repo!.length)[0];
    if (hit) return { repo: hit.repo, path: hit.path, via: 'paths' };
  }
  if (f.branch && !/^(main|master|develop|dev|HEAD)$/.test(f.branch) && branchOwners.has(f.branch)) return { repo: branchOwners.get(f.branch)!, path: null, via: 'branch' };
  return { repo: null, path: null, via: null };
}
const leaf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Deterministic one-line summary; the AI may replace it for sessions that become tasks. */
export function heuristicSummary(f: SessionFacts): string {
  const head = f.title ? `${f.title}. ` : '';
  const tail = f.last_assistant ? ` Last reply: ${f.last_assistant}` : '';
  return clip(`${head}${f.user_turns} requests, ${f.tool_calls} tool calls.${tail}`, 300);
}
