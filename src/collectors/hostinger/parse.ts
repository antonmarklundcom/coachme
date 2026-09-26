import { posix } from 'node:path';
import { redact } from '../../lib/redact.js';
export interface NodeApp { pid:number; app_dir:string; threads:number; is_next_build:boolean }
export interface Sample { account_id:string; at:string; procs:number; threads:number | null; node_apps:string; source:'ssh'|'manual' }
export function parse(raw: string, account_id: string, at: string): {sample:Sample;domains:string[]} {
  const lines = raw.split(/\r?\n/), cwd = new Map<number,string>(), apps: NodeApp[] = [], domains: string[] = [];
  let procs: number | undefined, threads: number | undefined;
  for (const line of lines) {
    const count = /^([PT])\s+(\d+)\s*$/.exec(line); if (count) { if (count[1] === 'P') procs = Number(count[2]); else threads = Number(count[2]); }
    const path = /^CWD\s+(\d+)\s+(\/.*)$/.exec(line); if (path) cwd.set(Number(path[1]),path[2].trim());
    const domain = /^D\s+((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\s*$/i.exec(line); if (domain) domains.push(domain[1].toLowerCase());
  }
  for (const line of lines) {
    const process = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); if (!process) continue;
    const args = process[3], pid = Number(process[1]);
    const path = /(?:^|\s)["']?(\/[^\s"']+)/g;
    const paths = [...args.matchAll(path)].map(m => m[1]).filter(p => !/^\/(?:usr|bin|opt\/node)(?:\/|$)/.test(p));
    const entry = paths[0];
    const inferred = entry?.includes('/node_modules/') ? entry.split('/node_modules/')[0] : entry ? /\.(?:[cm]?js)$/.test(entry) ? posix.dirname(entry) : entry : 'unknown (cwd unavailable)';
    apps.push({pid,app_dir:redact(cwd.get(pid) ?? inferred),threads:Number(process[2]),is_next_build:/\bnext\s+build\b/.test(args)});
  }
  if (procs === undefined || threads === undefined) throw new Error('Hostinger sample is missing P or T counts');
  return {sample:{account_id,at,procs,threads,node_apps:JSON.stringify(apps),source:'ssh'},domains:[...new Set(domains)]};
}
