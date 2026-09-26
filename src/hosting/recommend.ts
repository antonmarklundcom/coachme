import type { NodeApp, Sample } from '../collectors/hostinger/parse.js';
export interface Account {id:string;label:string;process_limit:number;has_ssh:number}
export const percentile = (values:number[],fraction:number) => { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.max(0,Math.ceil(sorted.length * fraction)-1)] ?? 0; };
export function recommend(account:Account,accounts:Account[],samples:Sample[],now:Date):string[] {
  const recent = samples.filter(s => Date.parse(s.at) >= now.getTime() - 7 * 86_400_000 && Date.parse(s.at) <= now.getTime());
  const own = recent.filter(s => s.account_id === account.id), output:string[] = [];
  if (!own.length) return [`${account.label}: configure SSH or post the hPanel number to see hosting pressure.`];
  const appSamples = own.flatMap(s => JSON.parse(s.node_apps ?? '[]') as NodeApp[]), byApp = new Map<string,number>();
  for (const app of appSamples) byApp.set(app.app_dir,Math.max(byApp.get(app.app_dir) ?? 0,app.threads));
  const apps = [...byApp].sort((a,b) => b[1]-a[1]), highest = apps[0];
  const pressure = (rows:Sample[]) => percentile(rows.map(s => Math.max(s.procs,s.threads ?? 0)),.95);
  if (pressure(own) > .8 * account.process_limit && highest) {
    const destination = accounts.filter(a => a.id !== account.id && recent.some(s => s.account_id === a.id)).map(a => ({...a,headroom:a.process_limit - pressure(recent.filter(s => s.account_id === a.id))})).sort((a,b) => b.headroom-a.headroom)[0];
    if (destination) output.push(`Move ${highest[0]} from ${account.label} to ${destination.label}, which has the most measured headroom (${Math.round(destination.headroom)}). Seven-day p95 exceeds 80% of the limit.`);
    else output.push(`${account.label} exceeds 80% of its limit at seven-day p95. Measure another account before choosing where to move ${highest[0]}.`);
  }
  if (own.some(s => (JSON.parse(s.node_apps ?? '[]') as NodeApp[]).filter(a => a.is_next_build).length >= 2)) output.push('Stagger merges and deploys: two or more Next.js builds ran concurrently.');
  if (highest && apps.length > 1) {
    const peers = apps.slice(1).map(a => a[1]).sort((a,b) => a-b), middle = Math.floor(peers.length/2), median = peers.length % 2 ? peers[middle] : (peers[middle-1]+peers[middle])/2;
    if (highest[1] > 2 * median) output.push(`${highest[0]} is the heaviest app (${highest[1]} threads), exceeding twice the median of its peers (${median}).`);
  }
  return output;
}
export interface Deploy {repo:string;at:string;sha:string}
export function correlate(samples:Sample[],deploys:Deploy[],limit:number):{at:string;repo:string;label:string}[] {
  const sorted = [...samples].sort((a,b) => Date.parse(a.at)-Date.parse(b.at));
  return sorted.flatMap((s,i) => {
    if (Math.max(s.procs,s.threads ?? 0) <= .8 * limit && !(i > 0 && s.threads !== null && sorted[i-1].threads !== null && s.threads - sorted[i-1].threads! >= 30)) return [];
    const deploy = deploys.filter(d => Date.parse(s.at)-Date.parse(d.at) >= 0 && Date.parse(s.at)-Date.parse(d.at) <= 15*60_000).sort((a,b) => Date.parse(b.at)-Date.parse(a.at))[0];
    return deploy ? [{at:s.at,repo:deploy.repo,label:`likely from ${deploy.repo} deploy`}] : [];
  });
}
