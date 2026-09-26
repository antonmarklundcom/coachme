import { redact } from '../../lib/redact.js';
export const errorKinds = ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPERM','EACCES','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','SELF_SIGNED_CERT','TLS_ERROR','TOO_MANY_REDIRECTS','INVALID_REDIRECT','HTTP_5XX','NETWORK_ERROR'] as const;
export type ErrorKind = typeof errorKinds[number];
export interface RawCheck { host: string; at: string; dns_ok: boolean; status?: number; final_url?: string; redirects: number; ms: number; tls_expires_at?: string; html?: string; has_robots?: boolean; has_sitemap?: boolean; error_kind?: ErrorKind }
export interface DomainCheck { host: string; at: string; dns_ok: number; status: number | null; final_url: string | null; redirects: number; ms: number; tls_expires_at: string | null; title: string | null; has_robots: number; has_sitemap: number; has_lead_form: number; error_kind: string | null }
export function classify(error: unknown): ErrorKind {
  const e = error as { code?: string; name?: string; message?: string; cause?: unknown } | null;
  if (e?.cause) return classify(e.cause);
  const code = e?.code ?? e?.name ?? '';
  if (/self.signed|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN/i.test(`${code} ${e?.message ?? ''}`)) return 'SELF_SIGNED_CERT';
  if (/Timeout|AbortError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(code)) return 'ETIMEDOUT';
  if ((errorKinds as readonly string[]).includes(code)) return code as ErrorKind;
  if (/CERT|TLS|SSL/.test(code)) return 'TLS_ERROR';
  return 'NETWORK_ERROR';
}
export function placeholder(text: string): boolean { return /(?:welcome to|powered by)\s+hostinger|hostinger\s+(?:default|parking|parked)|parked\s+domain|domain\s+(?:is\s+)?parked|coming\s+soon|index\s+of\s*\/|default\s+(?:web\s*)?page|welcome to nginx/i.test(text) || /^\s*hostinger\s*$/i.test(text); }
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i').exec(tag)?.slice(1).find(x => x !== undefined) ?? '';
export function leadForm(html: string): boolean {
  for (const form of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)) {
    if ([...form[0].matchAll(/<input\b[^>]*>/gi)].some(m => /^(tel|email)$/i.test(attr(m[0],'type')) || /whatsapp|telefono|phone|email/i.test(attr(m[0],'name')))) return true;
  }
  const crm = (url:string) => { try { const host = new URL(url, 'https://local.invalid').hostname; return /(?:^|\.)clientes\.com\.py$/i.test(host) || /(?:^|\.)vendercrm(?:\.[a-z]+)+$/i.test(host); } catch { return false; } };
  if ([...html.matchAll(/<(?:script|form)\b[^>]*>/gi)].some(m => ['src','action'].some(a => crm(attr(m[0],a))))) return true;
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].some(script => [...script[1].matchAll(/https?:\/\/[^\s"'<>`]+/gi)].some(url => crm(url[0])));
}
export function parse(raw: RawCheck): DomainCheck {
  const html = raw.html ?? '', title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1].replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim() ?? '';
  return { host: raw.host, at: raw.at, dns_ok: Number(raw.dns_ok), status: raw.status ?? null, final_url: raw.final_url ? redact(raw.final_url) : null, redirects: raw.redirects, ms: raw.ms, tls_expires_at: raw.tls_expires_at ?? null, title: redact(title).slice(0,500) || null, has_robots: Number(!!raw.has_robots), has_sitemap: Number(!!raw.has_sitemap), has_lead_form: Number(leadForm(html)), error_kind: raw.error_kind ?? (raw.status && raw.status >= 500 ? 'HTTP_5XX' : placeholder(title) || placeholder(html) ? 'PLACEHOLDER' : null) };
}
