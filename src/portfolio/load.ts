import { readFileSync } from 'node:fs';
import { LineCounter, parseDocument, isNode } from 'yaml';
import { portfolioSchema, type Portfolio } from './schema.js';
export function loadPortfolio(text: string): Portfolio {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length) throw new Error(`Portfolio YAML syntax error at line ${lineCounter.linePos(doc.errors[0].pos[0]).line}`);
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 50 }); } catch { throw new Error('Portfolio YAML alias error at line 1'); }
  const result = portfolioSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = [...issue.path];
  if (issue.code === 'unrecognized_keys' && issue.keys.length) path.push(issue.keys[0]);
  let node = doc.getIn(path, true);
  while (!isNode(node) && path.length) { path.pop(); node = doc.getIn(path, true); }
  const offset = isNode(node) ? node.range?.[0] ?? 0 : 0;
  throw new Error(`Portfolio validation error at line ${lineCounter.linePos(offset).line} (${issue.path.join('.')}): ${issue.code}`);
}
export const loadPortfolioFile = (path: string) => loadPortfolio(readFileSync(path, 'utf8'));
