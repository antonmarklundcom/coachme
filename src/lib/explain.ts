import type { DomainCheck } from '../collectors/domains/parse.js';
export type Severity = 'ok' | 'amber' | 'red';
export const errorExplanations: Record<string,string> = {
  ENOTFOUND: "The domain does not resolve: DNS is missing or the domain expired.", EAI_AGAIN:'The DNS lookup temporarily failed; visitors may be unable to reach the site.',
  ECONNREFUSED:'The server refused the connection; the web app may be stopped.', ECONNRESET:'The server closed the connection before the page finished loading.', ETIMEDOUT:'The site took too long to respond.',
  ENETUNREACH:'The network is unreachable from this computer.', EHOSTUNREACH:'This computer cannot reach the site server.', EPERM:'This computer blocked the network check; the site could not be verified.', EACCES:'This computer denied permission for the network check; the site could not be verified.',
  CERT_HAS_EXPIRED:'The HTTPS certificate expired, so visitors see a warning.', ERR_TLS_CERT_ALTNAME_INVALID:'The HTTPS certificate is for a different domain, so visitors see a warning.', SELF_SIGNED_CERT:'The HTTPS certificate is self signed, so visitors see a warning.', TLS_ERROR:'The secure connection failed; visitors may see a certificate warning.',
  TOO_MANY_REDIRECTS:'The site redirects too many times; visitors cannot reach the page.', INVALID_REDIRECT:'The site sends visitors to an invalid redirect address.', HTTP_5XX:'The server failed to serve the page.', NETWORK_ERROR:'The site could not be reached because of a network error.', PLACEHOLDER:'The domain shows a parked or placeholder page instead of the project.'
};
export function explain(check: Partial<DomainCheck>, now = new Date()): {sentence:string;severity:Severity} {
  const result = (sentence:string,severity:Severity) => ({sentence,severity});
  if (check.error_kind === 'CERT_HAS_EXPIRED' || check.tls_expires_at && Date.parse(check.tls_expires_at) <= now.getTime()) return result(errorExplanations.CERT_HAS_EXPIRED,'red');
  if (check.status === 503 && (!check.error_kind || check.error_kind === 'HTTP_5XX')) return result('The Node app is down or restarting, often because of the process limit on Hostinger.','red');
  if (check.error_kind) return result(errorExplanations[check.error_kind] ?? 'The site check failed with an unrecognized error.',['PLACEHOLDER','EPERM','EACCES','ENETUNREACH'].includes(check.error_kind) ? 'amber' : 'red');
  if (check.status == null) return result('No site check is available yet.','amber');
  if (check.status >= 500) return result(errorExplanations.HTTP_5XX,'red');
  if (check.status >= 400) return result(check.status === 404 ? 'The requested page was not found.' : check.status === 401 || check.status === 403 ? 'The page requires access or blocks visitors.' : 'The server rejected the page request.','red');
  if (check.status >= 300) return result('The site redirects visitors but no final page was reached.','amber');
  if (check.status >= 200) {
    if (check.tls_expires_at && Date.parse(check.tls_expires_at) - now.getTime() < 14 * 86_400_000) return result('The site responds, but its HTTPS certificate expires in under 14 days.','amber');
    return result('The site is responding normally.','ok');
  }
  return result(check.status >= 100 ? 'The server sent an interim response without a completed page.' : 'The site returned an invalid response status.','amber');
}
