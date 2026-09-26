import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export interface DomainCandidate { repo: string; host: string; source: string; confidence: 'high' | 'medium' | 'low' }
export interface DiscoveryInput { repo: string; folder?: string; homepageUrl?: string | null; files: Record<string, string> }
export const discoveryPaths = ['CNAME', 'package.json', '.env.example', 'next-sitemap.config.js', 'README.md', 'index.html', 'src/app/layout.tsx', 'app/layout.tsx', 'src/lib/site.ts', 'src/config/site.ts', 'lib/site.ts', 'config.php', 'includes/config.php'] as const;
export const repoStem = (name: string) => name.toLowerCase().replace(/^app[.-]/, '').replace(/\.node$/, '').replace(/(?:\.\d+)+$/, '').replace(/[-.](?:com|org|net)[-.](?:py|se)$/, '');
const ignored = ['localhost', 'example.com', 'vercel.app', 'hostingersite.com', 'github.com', 'githubusercontent.com', 'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'cloudfront.net', 'googleapis.com', 'gstatic.com'];
export function domainHost(value: string): string | null {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.username || url.password || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || ignored.some(d => host === d || host.endsWith(`.${d}`)) || /(^|\.)cdn[.-]/.test(host)) return null;
    return host;
  } catch { return null; }
}
export function discoverDomains(input: DiscoveryInput): DomainCandidate[] {
  const result: DomainCandidate[] = [], seen = new Set<string>();
  const add = (value: string | undefined | null, source: string, confidence: DomainCandidate['confidence']) => {
    const host = value ? domainHost(value.trim()) : null;
    if (host && !seen.has(host)) { seen.add(host); result.push({ repo: input.repo, host, source, confidence }); }
    else if (host) {
      const previous = result.find(d => d.host === host)!;
      const rank = {low:0,medium:1,high:2};
      if (rank[confidence] > rank[previous.confidence]) Object.assign(previous, {source, confidence});
    }
  };
  add(input.files.CNAME?.trim(), 'CNAME', 'high');
  add(input.homepageUrl, 'homepageUrl', 'high');
  try { add(JSON.parse(input.files['package.json'] ?? '{}').homepage, 'package.json homepage', 'medium'); } catch { /* malformed optional hint */ }
  for (const match of (input.files['.env.example'] ?? '').matchAll(/^\s*[\w]*SITE_URL[\w]*\s*=\s*["']?([^\s"'#]+)/gm)) add(match[1], '.env.example SITE_URL', 'medium');
  for (const [file, text] of Object.entries(input.files)) if (/^next-sitemap\.config\.[cm]?[jt]s$/.test(file)) {
    for (const match of text.matchAll(/siteUrl\s*:\s*['"]([^'"]+)['"]/g)) add(match[1], `${file} siteUrl`, 'medium');
  }
  for (const [file, text] of Object.entries(input.files)) if (/^[^/]+\.html?$|^(?:src\/)?app\/layout\.[jt]sx?$/.test(file)) {
    for (const match of text.matchAll(/metadataBase\s*:\s*new URL\(['"]([^'"]+)['"]\)|canonical\s*:\s*['"]([^'"]+)['"]/g)) add(match[1] ?? match[2], `${file} metadata`, 'medium');
    for (const match of text.matchAll(/<(?:link|meta)\b[^>]*>/gi)) {
      const attrs = Object.fromEntries([...match[0].matchAll(/([\w:]+)\s*=\s*['"]([^'"]*)['"]/g)].map(m => [m[1].toLowerCase(), m[2]]));
      if (attrs.rel?.toLowerCase() === 'canonical') add(attrs.href, `${file} canonical`, 'medium');
      if (attrs.property?.toLowerCase() === 'og:url') add(attrs.content, `${file} og:url`, 'medium');
    }
  }
  for (const [file, text] of Object.entries(input.files)) {
    if (/^(?:src\/(?:lib|config)\/site\.ts|lib\/site\.ts|(?:includes\/)?config\.php)$/.test(file)) {
      const pattern = file.endsWith('.php')
        ? /(?:\b(?:SITE_?URL|BASE_?URL)\s*=\s*|\bdefine\s*\(\s*['"](?:SITE_?URL|BASE_?URL)['"]\s*,\s*)['"](https?:\/\/[^'"\s]+)['"]/gi
        : /\b(?:site_?url|base_?url|url)\s*[:=]\s*['"](https?:\/\/[^'"\s]+)['"]/gi;
      for (const match of text.matchAll(pattern)) add(match[1], `${file} site URL`, 'high');
    }
  }
  const stem = repoStem(input.repo).replace(/[^a-z0-9]/g, '');
  for (const match of (input.files['README.md'] ?? '').matchAll(/https?:\/\/[^\s<>"'`\)\]]+/g)) {
    const host = domainHost(match[0].replace(/[.,;]+$/, ''));
    if (host && stem && host.split('.').some(label => label.replace(/-/g, '') === stem)) add(host, 'README.md matching URL', 'medium');
  }
  for (const name of [input.repo, input.folder]) if (name && /^[a-z0-9-]+-(?:com|org|net)-(?:py|se)$/.test(name)) add(name.replace(/-(com|org|net)-(py|se)$/, '.$1.$2'), 'name pattern', 'low');
  return result;
}
export function readDiscoveryFiles(path: string): Record<string, string> {
  const files: Record<string, string> = {};
  const names = [...discoveryPaths, 'next-sitemap.config.cjs', 'next-sitemap.config.mjs', 'next-sitemap.config.ts',
    ...['src/app', 'app'].flatMap(p => ['ts', 'tsx', 'js', 'jsx'].map(ext => `${p}/layout.${ext}`)),
    ...readdirSync(path, { withFileTypes: true }).filter(f => f.isFile() && /\.html?$/.test(f.name)).map(f => f.name)];
  for (const name of names) if (existsSync(join(path, name))) files[name] = readFileSync(join(path, name), 'utf8');
  return files;
}
