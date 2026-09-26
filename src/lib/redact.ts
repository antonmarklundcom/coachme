const patterns = [
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
  /\b(?:sk-ant-|sk-|ghp_|github_pat_|gho_|xox[a-z]*-)[A-Za-z0-9_-]+/gi,
  /\bAKIA[A-Z0-9]+/g,
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[^\s"'<>]+/gi,
  /\b(?:password|passwd|secret|token|api_key)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s"'<>]*/gi,
  /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=[^\r\n]*/gm,
  /[A-Za-z0-9+/_=-]{32,}/g,
];
export function redact(text: string): string {
  return patterns.reduce((value, pattern) => value.replace(pattern, '[REDACTED]'), text);
}
