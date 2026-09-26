import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSeq, parseDocument, stringify } from 'yaml';
import type { Config } from '../config.js';
import type { Exec } from '../lib/exec.js';
import { redact } from '../lib/redact.js';
import { collectLocal, type LocalFact } from '../collectors/local/index.js';
import { discoverDomains, readDiscoveryFiles, type DomainCandidate, type DiscoveryInput } from './discover.js';
import { gatherRemoteFiles } from './remote.js';
import { loadPortfolio } from './load.js';
import type { Portfolio, Project } from './schema.js';
export interface GitHubRepo { name: string; isArchived: boolean; pushedAt: string | null; homepageUrl?: string | null; description?: string | null; defaultBranchRef?: { name: string } | null }
export interface Hint { name: string; tier?: string; pct?: number; blocker?: string }
export interface GenerateInputs { repos: GitHubRepo[]; local: LocalFact[]; domains: DomainCandidate[]; discoveryInputs?: DiscoveryInput[]; hints: Hint[]; existingYaml?: string; now: string; ownerTz?: string }
const clones = new Set(['ecom', 'lenceria', 'productos', 'mascota']);
const stem = (name: string) => name.toLowerCase().replace(/^app[.-]/, '').replace(/\.node$/, '').replace(/(?:\.\d+)+$/, '');

// Splice only the two sequence nodes. Everything else stays byte-for-byte intact.
function appendUnassigned(text: string, repos: string[], domains: Portfolio['unassigned']['domains']): string {
  const doc = parseDocument(text);
  const patches: { start: number; end: number; value: string }[] = [];
  for (const [key, additions] of [['repos', repos], ['domains', domains]] as const) {
    if (!additions.length) continue;
    const node = doc.getIn(['unassigned', key], true);
    if (!isSeq(node) || !node.range) throw new Error('Unassigned entries must be sequences');
    const [start, end] = node.range;
    if (node.flow) {
      const close = text.lastIndexOf(']', end - 1);
      const inside = text.slice(start + 1, close).trimEnd();
      patches.push({ start: close, end: close, value: `${node.items.length && !inside.endsWith(',') ? ', ' : ''}${additions.map(x => JSON.stringify(x)).join(', ')}` });
    } else {
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const indent = start - text.lastIndexOf('\n', start - 1) - 1;
      const added = stringify(additions).trimEnd().split('\n').map(line => ' '.repeat(indent) + line).join(eol);
      patches.push({ start: node.range[2], end: node.range[2], value: `${text[node.range[2] - 1] === '\n' ? '' : eol}${added}${eol}` });
    }
  }
  for (const p of patches.sort((a, b) => b.start - a.start)) text = text.slice(0, p.start) + p.value + text.slice(p.end);
  loadPortfolio(text); return text;
}
export function generatePortfolio(input: GenerateInputs): { portfolio: Portfolio; generatedYaml: string; portfolioYaml: string } {
  const repos = [...input.repos].sort((a,b) => a.name.localeCompare(b.name));
  const rank = {high:2,medium:1,low:0};
  const candidates = [...input.domains, ...(input.discoveryInputs ?? []).flatMap(discoverDomains)]
    .sort((a,b) => rank[b.confidence] - rank[a.confidence]);
  const discovered = candidates.filter((d,i,a) => a.findIndex(x => x.repo === d.repo && x.host === d.host) === i);
  const groups: GitHubRepo[][] = [];
  const hosts = (name: string) => discovered.filter(d => d.repo === name && d.confidence !== 'low').map(d => d.host);
  for (const repo of repos) {
    const matching = clones.has(repo.name) ? [] : groups.filter(group => !group.some(r => clones.has(r.name)) && group.some(r => stem(r.name) === stem(repo.name) || hosts(r.name).some(h => hosts(repo.name).includes(h))));
    if (!matching.length) groups.push([repo]);
    else {
      matching[0].push(repo);
      for (const extra of matching.slice(1)) { matching[0].push(...extra); groups.splice(groups.indexOf(extra), 1); }
    }
  }
  const assignedDomains = new Set<string>(), ids = new Set<string>();
  const projects: Project[] = groups.map(group => {
    const names = group.map(r => r.name), hints = input.hints.filter(h => names.includes(h.name));
    const archived = group.every(r => r.isArchived);
    const recent = group.some(r => !r.isArchived && r.pushedAt && Date.parse(input.now) - Date.parse(r.pushedAt) < 30 * 86_400_000);
    let id = stem(group[0].name).replace(/[^a-z0-9._-]/g, '-') || 'project';
    const base = id; let suffix = 2; while (ids.has(id)) id = `${base}-${suffix++}`; ids.add(id);
    const candidates = discovered.filter(d => names.includes(d.repo) && d.confidence !== 'low');
    const domains: Project['domains'] = [];
    for (const d of candidates) if (!assignedDomains.has(d.host)) { assignedDomains.add(d.host); domains.push({ host: d.host, source: d.source, confidence: d.confidence }); }
    const weight = Math.max(...hints.map(h => h.tier === 'infra' ? 1 : h.tier === 'revenue' ? 3 : 2), ...(hints.length ? [] : [2]));
    const related = clones.has(group[0].name) ? `related: same e-commerce template as ${[...clones].filter(name => name !== group[0].name).join(', ')}` : '';
    const notes = [related, ...hints.map(h => `${hints.length > 1 ? `${h.name}: ` : ''}v3 (2026-08): ${h.pct === undefined ? 'progress unknown' : `${h.pct}% done`}${h.blocker && h.blocker !== 'none' ? `, blocker ${h.blocker}` : ''}`)].filter(Boolean).join(' ');
    const name = group.length > 1 && group.every(repo => stem(repo.name) === stem(group[0].name)) ? id : group[0].name;
    return { id, name, repos: names, domains, stage: archived ? 'killed' : recent ? 'building' : 'planned',
      ...(archived ? { stage_before: 'planned' as const, status_note: 'Archived on GitHub' } : {}),
      market: domains.some(d => d.host.endsWith('.py')) ? 'PY' : domains.some(d => d.host.endsWith('.se')) ? 'SE' : 'unknown',
      kind: hints.some(h => h.tier === 'infra') ? 'infra' : 'unknown', money: { model: 'unknown', weight }, notes: redact(notes) };
  });
  const unassignedDomain = ({repo, ...d}: DomainCandidate): Portfolio['unassigned']['domains'][number] => ({...d,
    ...(d.confidence === 'low' ? {suggested_project: projects.find(p => p.repos.includes(repo))?.id ?? repo} : {})});
  const portfolio: Portfolio = { version: 1, owner_tz: input.ownerTz ?? 'America/Asuncion', limits: { hostinger_process_limit: 200 }, hosting_accounts: [], projects,
    unassigned: { repos: [], domains: discovered.filter(d => !assignedDomains.has(d.host)).filter((d,i,a) => a.findIndex(x => x.host === d.host) === i).map(unassignedDomain) },
    local_only: input.local.filter(l => l.local_only).map(l => ({ path: l.path, name: l.name })) };
  const generatedYaml = stringify(portfolio); loadPortfolio(generatedYaml);
  let portfolioYaml = generatedYaml;
  if (input.existingYaml !== undefined) {
    const old = loadPortfolio(input.existingYaml);
    const knownRepos = new Set([...old.projects.flatMap(p => p.repos), ...old.unassigned.repos]);
    const knownDomains = new Set([...old.projects.flatMap(p => p.domains), ...old.unassigned.domains].map(d => d.host));
    const newDomains = discovered.filter(d => !knownDomains.has(d.host)).filter((d,i,a) => a.findIndex(x => x.host === d.host) === i).map(d => {
      const entry = unassignedDomain(d);
      if (d.confidence === 'low') entry.suggested_project = old.projects.find(p => p.repos.includes(d.repo))?.id ?? entry.suggested_project;
      return entry;
    });
    portfolioYaml = appendUnassigned(input.existingYaml, repos.map(r => r.name).filter(r => !knownRepos.has(r)), newDomains);
  }
  return { portfolio, generatedYaml, portfolioYaml };
}
export async function generatePortfolioFiles(config: Config, exec: Exec, root = process.cwd(), now = new Date()): Promise<void> {
  const repos: GitHubRepo[] = JSON.parse(await exec('gh', ['repo', 'list', config.github_owner, '--limit', '200', '--json', 'name,isArchived,pushedAt,homepageUrl,description,defaultBranchRef']));
  const local = await collectLocal(config.local_roots, config.github_owner, exec);
  const discoveryInputs = await gatherRemoteFiles(exec, config.github_owner, repos.filter(r => !local.some(l => l.repo === r.name)));
  for (const repo of repos) {
    const checkouts = local.filter(l => l.repo === repo.name);
    for (const checkout of checkouts) discoveryInputs.push({ repo: repo.name, folder: checkout.name, homepageUrl: repo.homepageUrl, files: readDiscoveryFiles(checkout.path) });
  }
  const path = resolve(root, 'portfolio.yaml'), hintPath = resolve(root, 'docs/history/data/portfolio.json');
  const hints = existsSync(hintPath) ? JSON.parse(readFileSync(hintPath, 'utf8')).repos as Hint[] : [];
  const existingYaml = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const output = generatePortfolio({ repos, local, domains: [], discoveryInputs, hints, existingYaml, now: now.toISOString(), ownerTz: config.owner_tz });
  if (existingYaml !== undefined) writeFileSync(resolve(root, 'portfolio.generated.yaml'), output.generatedYaml);
  if (output.portfolioYaml !== existingYaml) writeFileSync(path, output.portfolioYaml);
}
