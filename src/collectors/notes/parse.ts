import type { SourceTask } from '../../tasks/store.js';

interface Line { n: number; text: string }
interface Section { heading: string; level: number; lines: Line[] }

const ITEM_START = /^\s*([-*+]|\d+[.)])\s+/;

/**
 * Split markdown into heading sections; text before the first heading is its own section.
 * A wrapped list item's indented continuation lines are joined onto the item's first line,
 * so a title is never cut at the line wrap. Line numbers stay those of the item's start.
 */
export function sections(text: string): Section[] {
  const out: Section[] = [{ heading: '', level: 0, lines: [] }];
  let fence = false, inItem = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; inItem = false; return; }
    if (fence) return;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) { out.push({ heading: heading[2], level: heading[1].length, lines: [] }); inItem = false; return; }
    const lines = out[out.length - 1].lines;
    if (inItem && /^\s+\S/.test(raw) && !ITEM_START.test(raw)) { lines[lines.length - 1].text += ` ${raw.trim()}`; return; }
    inItem = ITEM_START.test(raw);
    lines.push({ n: i + 1, text: raw });
  });
  return out;
}

const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^([-*+]|\d+[.)])\s+(.*)$/;          // top-level only (no indent)
const DONE_HEADING = /\b(fixed|resolved|closed|done|shipped|completed|history|changelog|archive)\b/i;
const NEXT_HEADING = /\b(next|todo|to do|pending|remaining|open|outstanding|follow[- ]?ups?|what'?s left|not done)\b/i;
const strike = /^~~.*~~$/;

/** First sentence, markdown emphasis and links stripped. */
export function titleOf(text: string) {
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
  const bold = /^\*\*(.+?)\*\*/.exec(text.trim());
  if (bold) return bold[1].replace(/[*_`]/g, '').replace(/[.:]\s*$/, '').trim();
  const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(plain);
  return (sentence ? sentence[1] : plain).replace(/[.:]\s*$/, '');
}

/** KNOWN-ISSUES.md: every top-level bullet outside "fixed/resolved" sections is an open issue. */
export function parseKnownIssues(file: string, text: string): SourceTask[] {
  const tasks: SourceTask[] = [];
  for (const s of sections(text)) {
    if (DONE_HEADING.test(s.heading)) continue;
    for (const line of s.lines) {
      const box = CHECKBOX.exec(line.text);
      if (box) { if (box[1] === ' ') tasks.push({ title: titleOf(box[2]), source_kind: 'known-issue', source_file: file, source_line: line.n, detail: s.heading || undefined }); continue; }
      const bullet = BULLET.exec(line.text);
      if (!bullet || strike.test(bullet[2].trim()) || titleOf(bullet[2]).length < 6) continue;
      tasks.push({ title: titleOf(bullet[2]), source_kind: 'known-issue', source_file: file, source_line: line.n, detail: s.heading || undefined });
    }
  }
  return tasks;
}

/** HANDOFF*.md: unchecked boxes anywhere, plus bullets under "next / todo / remaining" headings. */
export function parseHandoff(file: string, text: string): SourceTask[] {
  const tasks: SourceTask[] = [];
  for (const s of sections(text)) {
    const next = NEXT_HEADING.test(s.heading) && !DONE_HEADING.test(s.heading);
    for (const line of s.lines) {
      const box = CHECKBOX.exec(line.text);
      if (box) { if (box[1] === ' ') tasks.push({ title: titleOf(box[2]), source_kind: 'handoff', source_file: file, source_line: line.n, detail: s.heading || undefined }); continue; }
      const bullet = next && BULLET.exec(line.text);
      if (bullet && titleOf(bullet[2]).length >= 6) tasks.push({ title: titleOf(bullet[2]), source_kind: 'handoff', source_file: file, source_line: line.n, detail: s.heading || undefined });
    }
  }
  return tasks;
}

/**
 * plan.md / PLAN.md: the current phase is the first heading section (in document order)
 * that still has an unchecked box. Its unchecked items become tasks; closeness grows with
 * the share already ticked (≥80% ticked reads as nearly done).
 */
export function parsePlan(file: string, text: string): SourceTask[] {
  for (const s of sections(text)) {
    const boxes = s.lines.map(line => ({ line, m: CHECKBOX.exec(line.text) })).filter(b => b.m);
    const open = boxes.filter(b => b.m![1] === ' ');
    if (!open.length) continue;
    const ratio = (boxes.length - open.length) / boxes.length;
    const closeness = ratio >= 0.8 ? 0.8 : Math.round((0.4 + 0.4 * ratio) * 100) / 100;
    return open.map(b => ({ title: titleOf(b.m![2]), source_kind: 'plan-phase' as const, source_file: file, source_line: b.line.n, detail: `${s.heading || 'Plan'} (${Math.round(ratio * 100)}% ticked)`, closeness }));
  }
  return [];
}

const TODO = /(?:\/\/|#|\/\*|<!--|\*|--)\s*(?:TODO|FIXME)\b(?:\s*\(([^)]*)\))?[\s:\-–]*(.{4,})/;
/** TODO / FIXME comments in a source file. */
export function parseTodos(file: string, text: string): SourceTask[] {
  const tasks: SourceTask[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = TODO.exec(line);
    if (!m) return;
    const title = m[2].replace(/\*\/|-->/g, '').trim();
    if (title.length >= 4) tasks.push({ title: `TODO: ${title}`, source_kind: 'todo', source_file: file, source_line: i + 1, detail: m[1] ? `TODO(${m[1].trim()})` : undefined });
  });
  return tasks;
}

export const NOTE_FILES = /^(KNOWN-ISSUES\.md|HANDOFF[^/\\]*\.md|plan\.md|PLAN\.md)$/i;
export function parseNoteFile(file: string, text: string): SourceTask[] {
  const base = file.split(/[\\/]/).pop() ?? file;
  if (/^KNOWN-ISSUES\.md$/i.test(base)) return parseKnownIssues(file, text);
  if (/^HANDOFF.*\.md$/i.test(base)) return parseHandoff(file, text);
  if (/^plan\.md$/i.test(base)) return parsePlan(file, text);
  return parseTodos(file, text);
}
