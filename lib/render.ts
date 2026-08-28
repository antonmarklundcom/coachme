/**
 * render.ts — a deliberately tiny mustache-shaped renderer.
 *
 * A faithful TypeScript port of `scripts/legacy/src/template.js` (plan.md §1,
 * "port, don't rewrite"). Enough for the runbook templates, small enough to
 * read in one sitting. No dependencies, no code execution, no partials.
 *
 *   {{name}}            escaped-as-is interpolation (see `escape` option)
 *   {{{name}}}          raw interpolation
 *   {{#list}}…{{/list}} section: repeats for arrays, renders once for truthy
 *   {{^list}}…{{/list}} inverted section: renders when falsy or empty
 *   {{.}}               the current item inside an array section
 *   a.b.c               dotted lookup
 *
 * Unknown keys render as the empty string. Sections push a new scope that
 * falls back to the enclosing one. A section tag alone on a line takes the whole
 * line with it, so markdown templates keep their blank-line structure instead of
 * sprouting a gap wherever a section opened.
 */

export type Scope = Record<string, unknown> | unknown[] | string | number | boolean | null | undefined;

const SECTION = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;

function lookup(scopes: Scope[], path: string): unknown {
  if (path === '.') return scopes[scopes.length - 1];
  const [head, ...rest] = path.split('.');
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (scope && typeof scope === 'object' && !Array.isArray(scope) && head in scope) {
      let value: unknown = (scope as Record<string, unknown>)[head];
      for (const key of rest) {
        if (value == null) return undefined;
        value = (value as Record<string, unknown>)[key];
      }
      return value;
    }
  }
  return undefined;
}

// 0 counts as empty: sections are used as "is there anything here?" guards, and
// "lists 0 further variables" is a paragraph that should not render.
const isEmpty = (v: unknown): boolean =>
  v == null || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0);

/** Drop the newline after a section tag that sits alone on its own line. */
const trimStandaloneTags = (tpl: string): string =>
  tpl.replace(/^[ \t]*(\{\{[#^/][^}]+\}\})[ \t]*\r?\n/gm, '$1');

export function render(
  template: string,
  data: Record<string, unknown>,
  { escape = (s: string) => s }: { escape?: (s: string) => string } = {}
): string {
  const run = (tpl: string, scopes: Scope[]): string => {
    let out = tpl;

    // Sections first, innermost-last: the regex is non-greedy so nested
    // sections of the same name are not supported (we do not need them).
    for (let m = SECTION.exec(out); m; m = SECTION.exec(out)) {
      const [whole, kind, name, body] = m;
      const value = lookup(scopes, name);
      let replacement = '';
      if (kind === '#') {
        if (Array.isArray(value)) {
          replacement = value.map((item) => run(body, [...scopes, item])).join('');
        } else if (!isEmpty(value)) {
          replacement = run(body, [...scopes, typeof value === 'object' ? (value as Scope) : {}]);
        }
      } else if (isEmpty(value)) {
        replacement = run(body, scopes);
      }
      out = out.slice(0, m.index) + replacement + out.slice(m.index + whole.length);
    }

    out = out.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, name) => String(lookup(scopes, name) ?? ''));
    out = out.replace(/\{\{\s*([\w.]+|\.)\s*\}\}/g, (_, name) => {
      const value = lookup(scopes, name);
      return value == null ? '' : escape(String(value));
    });
    return out;
  };

  return run(trimStandaloneTags(template), [data]);
}

export const escapeHtml = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c]);
