import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { classify, type RawCheck } from './parse.js';
export const USER_AGENT = 'coachme-healthcheck/4';
export interface Dependencies { dns(host: string): Promise<unknown>; fetch: typeof fetch; tls(host: string): Promise<string | undefined>; now(): Date }
export const tlsExpiry = (host: string): Promise<string | undefined> => new Promise((resolve,reject) => {
  const socket = connect({host,port:443,servername:host});
  const timer = setTimeout(() => finish(Object.assign(new Error('TLS timed out'),{code:'ETIMEDOUT'})),15_000);
  function finish(error?: Error) { clearTimeout(timer); if (error) reject(error); else { const valid = socket.getPeerCertificate().valid_to; resolve(valid ? new Date(valid).toISOString() : undefined); } socket.destroy(); }
  socket.once('secureConnect',() => finish()); socket.once('error',finish);
});
const defaults: Dependencies = {dns:lookup,fetch:globalThis.fetch,tls:tlsExpiry,now:() => new Date()};
async function request(url: string, deps: Dependencies, readHtml: boolean) {
  const response = await deps.fetch(url,{redirect:'manual',headers:{'User-Agent':USER_AGENT},signal:AbortSignal.timeout(15_000)});
  let html = '';
  if (readHtml && !(response.status >= 300 && response.status < 400) && (!response.headers.get('content-type') || /html/i.test(response.headers.get('content-type')!))) {
    const reader = response.body?.getReader(), decoder = new TextDecoder(); let bytes = 0;
    if (reader) try { while (bytes < 200 * 1024) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0,200 * 1024 - bytes); bytes += chunk.length; html += decoder.decode(chunk,{stream:true}); } html += decoder.decode(); } finally { await reader.cancel(); }
  } else await response.body?.cancel();
  return {status:response.status,location:response.headers.get('location'),html};
}
export async function check(host: string, injected: Partial<Dependencies> = {}): Promise<RawCheck> {
  const deps = {...defaults,...injected}, start = deps.now().getTime();
  const raw: RawCheck = {host,at:deps.now().toISOString(),dns_ok:false,redirects:0,ms:0};
  try {
    await Promise.race([deps.dns(host),new Promise((_,reject) => { const signal = AbortSignal.timeout(15_000); signal.addEventListener('abort',() => reject(Object.assign(new Error('DNS timed out'),{code:'ETIMEDOUT'})),{once:true}); })]); raw.dns_ok = true;
    // Keep TLS failure independent of the HTTP result, without relaxing certificate validation.
    const tls = deps.tls(host).then(value => ({value}),error => ({error}));
    try {
      let url = `https://${host}/`;
      for (;;) {
        const page = await request(url,deps,true); raw.status = page.status; raw.final_url = url; raw.html = page.html;
        if (![301,302,303,307,308].includes(page.status) || !page.location) break;
        if (raw.redirects === 5) { raw.error_kind = 'TOO_MANY_REDIRECTS'; break; }
        let next: URL;
        try { next = new URL(page.location,url); if (!['https:','http:'].includes(next.protocol) || next.username || next.password) throw new Error(); } catch { raw.error_kind = 'INVALID_REDIRECT'; break; }
        url = next.href; raw.redirects++;
      }
    } catch (error) { raw.error_kind = classify(error); }
    const cert = await tls; if ('error' in cert) raw.error_kind = classify(cert.error); else raw.tls_expires_at = cert.value;
    if (raw.status) {
      const origin = new URL(raw.final_url ?? `https://${host}`).origin;
      for (const [path,key] of [['robots.txt','has_robots'],['sitemap.xml','has_sitemap']] as const) {
        try { const result = await request(`${origin}/${path}`,deps,false); raw[key] = result.status >= 200 && result.status < 300; } catch { raw[key] = false; }
      }
    }
  } catch (error) { raw.error_kind = classify(error); }
  raw.ms = Math.max(0,deps.now().getTime() - start); return raw;
}
