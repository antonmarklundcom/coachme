/**
 * markdown.ts — a documented subset of Markdown → HTML.
 *
 * A faithful TypeScript port of `scripts/legacy/src/markdown.js` (plan.md §1,
 * "port, don't rewrite"). Only what the runbooks actually use, so the
 * dashboard can show a runbook inline on a phone instead of sending the owner
 * to GitHub mid-session: ATX headings, fenced code, unordered and ordered
 * lists, blockquotes, pipe tables, paragraphs, and inline `code`, **bold**,
 * *italic*, links.
 *
 * Everything is escaped first; no raw HTML passes through. This is what makes
 * it safe to inject the result with `dangerouslySetInnerHTML` — the source is
 * always this app's own generated runbook text, never user input.
 */

import { escapeHtml } from './render';

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noopener">$2</a>');
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const splitRow = (line: string): string[] =>
  line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownToHtml(md: string, { headingOffset = 0 }: { headingOffset?: number } = {}): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
    buf.length = 0;
  };
  const paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // fenced code — verbatim, never inline-formatted
    if (/^\s*```/.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(6, heading[1].length + headingOffset);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(body.join('\n'), { headingOffset })}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph(paragraph);
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        let item = lines[i++].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '');
        // Continuation lines are indented under the marker. The guard tests for
        // a real list marker, not just a leading character — an indented line
        // that opens with emphasis (`*"…"*`) is continuation, not a new item.
        const startsItem = (l: string) => /^([-*]\s+|\d+\.\s+)/.test(l.trim());
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !startsItem(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (isTableRow(line) && isTableRow(lines[i + 1] ?? '') && /^[\s|:-]+$/.test(lines[i + 1])) {
      flushParagraph(paragraph);
      const head = splitRow(lines[i]);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) body.push(splitRow(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph(paragraph);
  return out.join('\n');
}
