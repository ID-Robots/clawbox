/**
 * The Markdown half of an OpenClaw progress card (TASK-896).
 *
 * The agent writes it with the `progress_card` tool and the gateway stores it
 * as-is (OpenClaw's docs/tools/progress-card.md): "ordinary formatting, links,
 * and optional progress bars" — a `<progress aria-label value max>` element is
 * the one piece of raw HTML the format documents, and "other raw HTML is
 * stripped by the Markdown sanitizer". This module is that sanitiser for the
 * ClawBox chat: it parses the documented subset into a small tree the card
 * draws as React elements. Nothing here ever becomes HTML — there is no
 * `innerHTML` on the path — so an allowed element is one this parser produced
 * a node for, and everything else is plain text or gone:
 *
 * - blocks: paragraphs, headings, GFM pipe tables, bullet / ordered / task
 *   lists, block quotes, fenced code, horizontal rules, a progress bar alone
 *   on its line;
 * - inline: bold, italic, strikethrough, code spans, links (http, https and
 *   mailto only — anything else keeps its words and loses the link), bare
 *   http(s) URLs, `<br>`, and `<progress>` inside a line or a table cell;
 * - every other tag is dropped with its markup (its words stay), and the
 *   elements whose content is not prose — script, style, iframe, svg… — are
 *   dropped WITH their content, the way an HTML sanitiser does; comments go
 *   too. Images keep only their alt text.
 */

export type TableAlign = "left" | "center" | "right" | null;

export interface ProgressBar {
  /** null = an indeterminate bar (no `value`, as in HTML). */
  value: number | null;
  max: number;
  label: string | null;
}

export type ProgressInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: ProgressInline[] }
  | { type: "em"; children: ProgressInline[] }
  | { type: "del"; children: ProgressInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: ProgressInline[] }
  | { type: "break" }
  | ({ type: "progress" } & ProgressBar);

export interface ProgressListItem {
  children: ProgressInline[];
  /** Nesting level, 0 for a top-level item (capped at MAX_LIST_DEPTH). */
  depth: number;
  /** A task-list item's box (`- [x]`), null for a plain item. */
  checked: boolean | null;
}

export type ProgressBlock =
  | { type: "paragraph"; children: ProgressInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: ProgressInline[] }
  | { type: "list"; ordered: boolean; start: number; items: ProgressListItem[] }
  | { type: "table"; align: TableAlign[]; header: ProgressInline[][]; rows: ProgressInline[][][] }
  | { type: "quote"; children: ProgressBlock[] }
  | { type: "code"; text: string }
  | { type: "rule" }
  | ({ type: "progress" } & ProgressBar);

/** The gateway caps the note at 8,192 UTF-8 bytes; this bounds the parser's work even if it did not. */
export const MAX_MARKDOWN_CHARS = 16_384;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 20;
const MAX_LIST_DEPTH = 3;
const MAX_QUOTE_DEPTH = 3;
const MAX_INLINE_DEPTH = 8;
const MAX_LABEL_CHARS = 160;

/** Elements whose content is code or markup, not prose: removed together with everything inside. */
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "noscript", "noembed", "noframes", "template", "textarea", "title", "svg",
  "math", "select", "xmp", "head",
];
const DROP_WITH_CONTENT_RE = new RegExp(
  `<(${DROP_WITH_CONTENT.join("|")})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`,
  "gi",
);
// A self-closed <svg/> or <iframe .../> has no content to take with it.
const SELF_CLOSED_DROP_RE = new RegExp(`<(${DROP_WITH_CONTENT.join("|")})\\b[^>]*\\/>`, "gi");
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
// Declarations and processing instructions (`<!DOCTYPE …>`, `<?xml …?>`, CDATA).
const DECLARATION_RE = /<![A-Za-z[][^>]*>|<\?[\s\S]*?(?:\?>|$)/g;

// Zero-width, bidirectional-control and other invisible characters (the
// gateway removes them before storing; a card from an older store may not
// have been), C0/C1 controls other than tab and newline, and the private-use
// characters this parser uses as its own placeholders.
const INVISIBLE_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uE000-\uE001]/g;

const CODE_SPAN_TOKEN = "\uE000";
const CODE_SPAN_END = "\uE001";

/** Clean the raw note: newlines normalised, invisible characters removed, length bounded. */
export function normalizeProgressMarkdown(raw: string): string {
  return raw
    .slice(0, MAX_MARKDOWN_CHARS)
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_RE, "")
    .replace(/\t/g, "    ");
}

/**
 * Where the code span opening at `i` closes: the next backtick run of exactly
 * the same length before `limit`, or null when the run has no partner (it is
 * then literal backticks). Linear in the distance scanned; every caller skips
 * the whole run on a null, so a note of nothing but backticks costs one pass
 * per distinct run length, not one per character.
 */
function codeSpanEnd(src: string, i: number, limit = src.length): { run: number; close: number } | null {
  let run = 0;
  while (src[i + run] === "`") run += 1;
  let j = i + run;
  while (j < limit) {
    const next = src.indexOf("`", j);
    if (next === -1 || next >= limit) return null;
    let closeRun = 0;
    while (src[next + closeRun] === "`") closeRun += 1;
    if (closeRun === run) return { run, close: next };
    j = next + closeRun;
  }
  return null;
}

function backtickRun(src: string, i: number): number {
  let run = 0;
  while (src[i + run] === "`") run += 1;
  return run;
}

/**
 * Swap every code span in `text` for a placeholder, so the HTML removal below
 * cannot reach inside one. A span never crosses a blank line (that is a new
 * paragraph, where its backticks could not pair either).
 */
function protectCodeSpans(text: string, spans: string[]): string {
  const blankLine = /\n[ \t]*\n/g;
  let nextBlank = -1;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, tick);
    if (nextBlank !== text.length && nextBlank < tick) {
      blankLine.lastIndex = tick;
      const found = blankLine.exec(text);
      nextBlank = found ? found.index : text.length;
    }
    const span = codeSpanEnd(text, tick, nextBlank);
    if (span) {
      spans.push(text.slice(tick, span.close + span.run));
      out += `${CODE_SPAN_TOKEN}${spans.length - 1}${CODE_SPAN_END}`;
      i = span.close + span.run;
    } else {
      const run = backtickRun(text, tick);
      out += text.slice(tick, tick + run);
      i = tick + run;
    }
  }
  return out;
}

/**
 * Remove the raw HTML that must not survive as text either — comments,
 * declarations and the content-carrying elements — from prose that is NOT
 * inside a code span (a code span shows its characters literally, so
 * `` `<script>` `` is a legitimate thing for a note to say).
 */
function stripHtmlBlocks(text: string): string {
  const spans: string[] = [];
  const protectedText = protectCodeSpans(text, spans);
  const stripped = protectedText
    .replace(COMMENT_RE, "")
    .replace(DECLARATION_RE, "")
    .replace(SELF_CLOSED_DROP_RE, "")
    .replace(DROP_WITH_CONTENT_RE, "");
  return stripped.replace(
    new RegExp(`${CODE_SPAN_TOKEN}(\\d+)${CODE_SPAN_END}`, "g"),
    (_m, index: string) => spans[Number(index)] ?? "",
  );
}

// ─── Blocks ────────────────────────────────────────────────────────────────

// Every block pattern is anchored and free of nested or adjacent ambiguous
// quantifiers, so none of them can backtrack on a long line; the two that
// could (a heading's closing hashes, a table's delimiter row) are read by
// hand below instead.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_OPEN_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function fenceOpen(line: string): string | null {
  const fence = FENCE_RE.exec(line);
  // A backtick fence's info string cannot hold a backtick: "```x```" is inline code.
  if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) return null;
  return fence[1];
}

function isFenceClose(line: string, marker: string): boolean {
  const close = FENCE_CLOSE_RE.exec(line);
  return close !== null && close[1][0] === marker[0] && close[1].length >= marker.length;
}

/** An ATX heading: 1-6 hashes, a space, the text, optional closing hashes. */
function parseHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const open = HEADING_OPEN_RE.exec(line);
  if (!open) return null;
  let text = line.slice(open[0].length).trim();
  // Closing hashes count only when a space separates them from the text (`# C#` keeps its hash).
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === 0) text = "";
  else if (end < text.length && (text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
  return { level: open[1].length as 1 | 2 | 3 | 4 | 5 | 6, text };
}

/** A GFM delimiter row (`| --- | :-: |`), read cell by cell. */
function isDelimiterRow(line: string): boolean {
  if (!line.includes("-") || /^ {4}/.test(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Split a table row on its unescaped pipes (a pipe inside a code span or escaped as `\|` is text). */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run += 1;
      if (inCode === 0) inCode = run;
      else if (inCode === run) inCode = 0;
      current += text.slice(i, i + run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && inCode === 0) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (delimiter === undefined || !header.includes("|")) return false;
  if (!isDelimiterRow(delimiter)) return false;
  // GFM: a table needs a pipe in the delimiter row unless it is a single column,
  // and the header and delimiter rows must agree on the number of columns.
  if (!delimiter.includes("|") && splitTableRow(header).length > 1) return false;
  return splitTableRow(header).length === splitTableRow(delimiter).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    fenceOpen(line) !== null ||
    HEADING_OPEN_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    (LIST_ITEM_RE.test(line) && (LIST_ITEM_RE.exec(line)?.[3] ?? "").trim() !== "") ||
    isTableStart(lines, i)
  );
}

function parseBlockLines(lines: string[], quoteDepth: number): ProgressBlock[] {
  const blocks: ProgressBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const marker = fenceOpen(line);
    if (marker !== null) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        if (isFenceClose(lines[i], marker)) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      const children = parseProgressInline(heading.text);
      if (children.length > 0) blocks.push({ type: "heading", level: heading.level, children });
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitTableRow(line).slice(0, MAX_TABLE_COLUMNS);
      const align = splitTableRow(lines[i + 1]).slice(0, header.length).map(tableAlign);
      const rows: ProgressInline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|") && !startsBlockOtherThanTable(lines, i)) {
        if (rows.length < MAX_TABLE_ROWS) {
          const cells = splitTableRow(lines[i]);
          const row: ProgressInline[][] = [];
          for (let c = 0; c < header.length; c += 1) row.push(parseProgressInline(cells[c] ?? ""));
          rows.push(row);
        }
        i += 1;
      }
      blocks.push({ type: "table", align, header: header.map((cell) => parseProgressInline(cell)), rows });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(QUOTE_RE.exec(lines[i])?.[1] ?? "");
        i += 1;
      }
      if (quoteDepth >= MAX_QUOTE_DEPTH) {
        const children = parseProgressInline(inner.join("\n"));
        if (children.length > 0) blocks.push({ type: "paragraph", children });
      } else {
        const children = parseBlockLines(inner, quoteDepth + 1);
        if (children.length > 0) blocks.push({ type: "quote", children });
      }
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item && (item[3] ?? "").trim() !== "") {
      const ordered = /\d/.test(item[2]);
      const start = ordered ? Math.min(Number.parseInt(item[2], 10), 1_000_000) : 1;
      const baseIndent = item[1].length;
      const raw: Array<{ text: string[]; depth: number }> = [];
      while (i < lines.length) {
        const candidate = LIST_ITEM_RE.exec(lines[i]);
        const hasText = candidate !== null && (candidate[3] ?? "").trim() !== "";
        // The next item of this list — same kind at any indent — or a nested one of either kind.
        if (candidate && hasText && (/\d/.test(candidate[2]) === ordered || candidate[1].length > baseIndent)) {
          const depth = Math.min(MAX_LIST_DEPTH, Math.max(0, Math.floor((candidate[1].length - baseIndent) / 2)));
          raw.push({ text: [candidate[3] ?? ""], depth });
          i += 1;
          continue;
        }
        if (isBlank(lines[i])) break;
        // A continuation line (lazy or indented) belongs to the item above it,
        // unless it opens a block of its own.
        const last = raw[raw.length - 1];
        if (last && !startsBlock(lines, i)) {
          last.text.push(lines[i].trim());
          i += 1;
          continue;
        }
        break;
      }
      const items: ProgressListItem[] = raw.map(({ text: parts, depth }) => {
        let text = parts.join("\n");
        let checked: boolean | null = null;
        const task = /^\[([ xX])\][ \t]+/.exec(text);
        if (task) {
          checked = task[1] !== " ";
          text = text.slice(task[0].length);
        }
        return { children: parseProgressInline(text), depth, checked };
      });
      if (items.length > 0) blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      paragraph.push(lines[i]);
      i += 1;
    }
    const children = parseProgressInline(paragraph.map((l) => l.trim()).join("\n"));
    const meaningful = children.filter((node) => !(node.type === "text" && node.text.trim() === "") && node.type !== "break");
    if (meaningful.length === 1 && meaningful[0].type === "progress") {
      const { value, max, label } = meaningful[0];
      blocks.push({ type: "progress", value, max, label });
    } else if (meaningful.length > 0) {
      blocks.push({ type: "paragraph", children: trimBreaks(children) });
    }
  }
  return blocks;
}

function startsBlockOtherThanTable(lines: string[], i: number): boolean {
  const line = lines[i];
  return fenceOpen(line) !== null || HEADING_OPEN_RE.test(line) || QUOTE_RE.test(line);
}

function trimBreaks(nodes: ProgressInline[]): ProgressInline[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && nodes[start].type === "break") start += 1;
  while (end > start && nodes[end - 1].type === "break") end -= 1;
  return nodes.slice(start, end);
}

/** Parse a progress card's Markdown into the sanitised block tree the card draws. */
export function parseProgressMarkdown(raw: string): ProgressBlock[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const normalized = normalizeProgressMarkdown(raw);
  // Fenced code keeps its characters; everything between fences loses its raw-HTML blocks.
  const lines = normalized.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flushProse = () => {
    if (prose.length === 0) return;
    for (const cleaned of stripHtmlBlocks(prose.join("\n")).split("\n")) out.push(cleaned);
    prose = [];
  };
  for (const line of lines) {
    const marker: string | null = fence === null ? fenceOpen(line) : null;
    if (marker !== null) {
      flushProse();
      fence = marker;
      out.push(line);
    } else if (fence !== null) {
      out.push(line);
      if (isFenceClose(line, fence)) fence = null;
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return parseBlockLines(out, 0);
}

// ─── Inline ────────────────────────────────────────────────────────────────

const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00A0",
  ndash: "–", mdash: "—", hellip: "…", middot: "·",
  bull: "•", rarr: "→", larr: "←", times: "×", copy: "©",
};

function decodeEntity(src: string, i: number): { text: string; length: number } | null {
  const match = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/.exec(src.slice(i, i + 12));
  if (!match) return null;
  const body = match[1];
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    // No controls, no surrogates, nothing past Unicode, and none of the invisible characters stripped above.
    if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code >= 0x7f && code <= 0x9f)) return null;
    const text = String.fromCodePoint(code);
    if (text.replace(INVISIBLE_RE, "") === "") return { text: "", length: match[0].length };
    return { text, length: match[0].length };
  }
  const named = NAMED_ENTITIES[body];
  return named === undefined ? null : { text: named, length: match[0].length };
}

/** Decode the entities a Markdown author may type in a link destination or an attribute. */
function decodeEntities(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "&") {
      const entity = decodeEntity(text, i);
      if (entity) {
        out += entity.text;
        i += entity.length - 1;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

/**
 * The one test every link passes before it becomes an `<a>`: http and https
 * URLs (parsed, so the scheme is the one the browser will see) and mailto.
 * `javascript:`, `data:`, `vbscript:`, protocol-relative and relative
 * destinations all answer null and the link's words are drawn as text.
 */
export function sanitizeProgressHref(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // Read the way the browser's URL parser reads it, so the scheme tested here
  // is the one it would follow: entities decoded (a scheme can be spelled with
  // them), C0 controls and spaces trimmed from both ends, tabs and newlines
  // removed wherever they are. Any other control character refuses the link.
  const decoded = decodeEntities(raw);
  let start = 0;
  let end = decoded.length;
  while (start < end && decoded.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && decoded.charCodeAt(end - 1) <= 0x20) end -= 1;
  const candidate = decoded.slice(start, end).replace(/[\t\n\r]/g, "");
  if (candidate === "" || /[\u0000-\u001F\u007F]/.test(candidate)) return null;
  if (/^mailto:/i.test(candidate)) {
    return /^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(candidate) ? candidate : null;
  }
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attrs;
}

function parseNumberAttribute(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * A `<progress>` element's numbers the way HTML reads them: `max` defaults to
 * 1 and must be positive, `value` is clamped into [0, max], and a missing or
 * unreadable `value` is an indeterminate bar. The label is the element's
 * `aria-label` (the docs' "Tests · 3/7"), or its `title`.
 */
export function progressBarFromAttributes(source: string): ProgressBar {
  const attrs = parseAttributes(source);
  const parsedMax = parseNumberAttribute(attrs.get("max"));
  const max = parsedMax !== null && parsedMax > 0 ? parsedMax : 1;
  const parsedValue = parseNumberAttribute(attrs.get("value"));
  const value = parsedValue === null ? null : Math.min(max, Math.max(0, parsedValue));
  const rawLabel = attrs.get("aria-label") ?? attrs.get("title") ?? "";
  const label = rawLabel.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
  return { value, max, label: label === "" ? null : label };
}

const TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const AUTOLINK_RE = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;
const BARE_URL_RE = /^https?:\/\/[^\s<]+/i;

interface InlineOptions {
  depth: number;
  inLink: boolean;
}

function pushText(nodes: ProgressInline[], text: string): void {
  if (text === "") return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === "text") last.text += text;
  else nodes.push({ type: "text", text });
}

/**
 * One inline parse's memory. The scans below look AHEAD (for a closing `**`,
 * a `]`, a backtick partner), and a note can be written to make every opener
 * fail — the agent writes it, and the agent reads the web — so what a scan
 * already learnt is kept: each backtick run is resolved once, and once no
 * closer for a marker exists after some point, no later opener looks again.
 * Without this a few kilobytes of `*[` took tens of seconds to render.
 */
interface InlineScan {
  src: string;
  spans: Map<number, { run: number; close: number } | null>;
  noCloserFrom: Map<string, number>;
}

function spanAt(scan: InlineScan, i: number): { run: number; close: number } | null {
  let span = scan.spans.get(i);
  if (span === undefined) {
    span = codeSpanEnd(scan.src, i);
    scan.spans.set(i, span);
  }
  return span;
}

/** The farthest a link's text, destination or title is looked for; nothing a status card says is longer. */
const MAX_LINK_SCAN = 2048;
/** The longest tag the parser tries to read as one; a longer run after `<` is text. */
const MAX_TAG_CHARS = 2048;

/** The index of the closing delimiter `marker` for an emphasis opened before `from`, skipping code spans and escapes. */
function findClosing(scan: InlineScan, from: number, marker: string): number {
  const { src } = scan;
  const failedFrom = scan.noCloserFrom.get(marker);
  if (failedFrom !== undefined && from >= failedFrom) return -1;
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const span = spanAt(scan, i);
      i = span ? span.close + span.run : i + backtickRun(src, i);
      continue;
    }
    if (src.startsWith(marker, i)) {
      const before = src[i - 1];
      const after = src[i + marker.length];
      const markerChar = marker[0];
      // Closing needs a non-space before it, and must not be the start of a longer run of the same character
      // (so `**` does not close on the first half of `***`… unless nothing longer follows).
      const rightFlanking = before !== undefined && !/\s/.test(before);
      const intraword = markerChar === "_" && after !== undefined && /[\p{L}\p{N}]/u.test(after);
      if (i > from && rightFlanking && !intraword && after !== markerChar) return i;
      if (i > from && rightFlanking && !intraword && after === markerChar && marker.length === 1) {
        // `*a**b*`-style runs are rare in a status note; skip past the run.
        let run = 0;
        while (src[i + run] === markerChar) run += 1;
        i += run;
        continue;
      }
    }
    i += 1;
  }
  scan.noCloserFrom.set(marker, Math.min(failedFrom ?? from, from));
  return -1;
}

/** Parse a link or image starting at `[` (or `![`); null when the brackets do not form one. */
function parseLink(scan: InlineScan, i: number): { text: string; href: string; end: number } | null {
  const { src } = scan;
  const textLimit = Math.min(src.length, i + MAX_LINK_SCAN);
  let depth = 0;
  let j = i;
  for (; j < textLimit; j += 1) {
    const ch = src[j];
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "`") {
      const span = spanAt(scan, j);
      j = (span ? span.close + span.run : j + backtickRun(src, j)) - 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || j >= textLimit || src[j + 1] !== "(") return null;
  const text = src.slice(i + 1, j);
  const limit = Math.min(src.length, j + 2 + MAX_LINK_SCAN);
  let k = j + 2;
  while (src[k] === " ") k += 1;
  let href = "";
  if (src[k] === "<") {
    const close = src.indexOf(">", k);
    if (close === -1 || close >= limit || src.slice(k, close).includes("\n")) return null;
    href = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const startHref = k;
    for (; k < limit; k += 1) {
      const ch = src[k];
      if (ch === "\\" && k + 1 < src.length) {
        k += 1;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "(") parens += 1;
      if (ch === ")") {
        if (parens === 0) break;
        parens -= 1;
      }
    }
    href = src.slice(startHref, k).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  }
  while (src[k] === " " || src[k] === "\n") k += 1;
  const quote = src[k];
  if (quote === "\"" || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    const close = src.indexOf(closer, k + 1);
    if (close === -1 || close >= limit) return null;
    k = close + 1;
    while (src[k] === " ") k += 1;
  }
  if (src[k] !== ")") return null;
  return { text, href, end: k + 1 };
}

/** Trim the punctuation a sentence puts after a bare URL, keeping a `)` the URL itself opened. */
function trimBareUrl(url: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of url) {
    if (ch === "(") opens += 1;
    else if (ch === ")") closes += 1;
  }
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (/[.,:;!?'"*_~]/.test(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")" && closes > opens) {
      closes -= 1;
      end -= 1;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

function parseInlineInto(src: string, options: InlineOptions): ProgressInline[] {
  const nodes: ProgressInline[] = [];
  if (options.depth > MAX_INLINE_DEPTH) {
    pushText(nodes, src);
    return nodes;
  }
  const scan: InlineScan = { src, spans: new Map(), noCloserFrom: new Map() };
  const nested = (text: string, inLink = options.inLink) =>
    parseInlineInto(text, { depth: options.depth + 1, inLink });
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && i + 1 < src.length && ASCII_PUNCTUATION.test(src[i + 1])) {
      pushText(nodes, src[i + 1]);
      i += 2;
      continue;
    }

    if (ch === "\n") {
      nodes.push({ type: "break" });
      i += 1;
      continue;
    }

    if (ch === "`") {
      const span = spanAt(scan, i);
      if (span) {
        let code = src.slice(i + span.run, span.close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
        nodes.push({ type: "code", text: code });
        i = span.close + span.run;
        continue;
      }
      let run = 0;
      while (src[i + run] === "`") run += 1;
      pushText(nodes, src.slice(i, i + run));
      i += run;
      continue;
    }

    if (ch === "<") {
      const auto = options.inLink ? null : AUTOLINK_RE.exec(src.slice(i, i + MAX_TAG_CHARS));
      if (auto) {
        const href = sanitizeProgressHref(auto[1]);
        const label = auto[1].replace(/^mailto:/i, "");
        if (href) nodes.push({ type: "link", href, children: [{ type: "text", text: label }] });
        else pushText(nodes, label);
        i += auto[0].length;
        continue;
      }
      const tag = TAG_RE.exec(src.slice(i, i + MAX_TAG_CHARS));
      if (tag) {
        const [whole, closing, rawName, attrs] = tag;
        const name = rawName.toLowerCase();
        i += whole.length;
        if (name === "progress" && !closing) {
          nodes.push({ type: "progress", ...progressBarFromAttributes(attrs) });
          // The element's own content is only a fallback for browsers without <progress>.
          // Looked for close by: a bar that is never closed does not swallow the rest of the note.
          const close = /^[^<]{0,256}<\/progress\s*>/i.exec(src.slice(i, i + 300));
          if (close) i += close[0].length;
        } else if (name === "br" && !closing) {
          nodes.push({ type: "break" });
        }
        // Every other tag — and a stray </progress> — is dropped; its words stay.
        continue;
      }
      pushText(nodes, "<");
      i += 1;
      continue;
    }

    if (ch === "&") {
      const entity = decodeEntity(src, i);
      if (entity) {
        pushText(nodes, entity.text);
        i += entity.length;
        continue;
      }
      pushText(nodes, "&");
      i += 1;
      continue;
    }

    if (ch === "!" && src[i + 1] === "[") {
      // Images are not part of a card: the alt text stays, the picture does not load.
      const image = parseLink(scan, i + 1);
      if (image) {
        for (const node of nested(image.text, true)) {
          if (node.type === "text") pushText(nodes, node.text);
          else nodes.push(node);
        }
        i = image.end;
        continue;
      }
    }

    if (ch === "[" && !options.inLink) {
      const link = parseLink(scan, i);
      if (link) {
        const href = sanitizeProgressHref(link.href);
        const children = nested(link.text, true);
        if (href) nodes.push({ type: "link", href, children });
        else for (const node of children) {
          if (node.type === "text") pushText(nodes, node.text);
          else nodes.push(node);
        }
        i = link.end;
        continue;
      }
    }

    if ((ch === "h" || ch === "H") && !options.inLink) {
      const before = src[i - 1];
      if (before === undefined || !/[\p{L}\p{N}]/u.test(before)) {
        const bare = BARE_URL_RE.exec(src.slice(i, i + MAX_LINK_SCAN));
        if (bare) {
          const url = trimBareUrl(bare[0]);
          const href = sanitizeProgressHref(url);
          if (href && url.length > "https://".length - 1) {
            nodes.push({ type: "link", href, children: [{ type: "text", text: url }] });
            i += url.length;
            continue;
          }
        }
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const close = findClosing(scan, i + 2, "~~");
      if (close !== -1 && !/\s/.test(src[i + 2] ?? " ")) {
        nodes.push({ type: "del", children: nested(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      let run = 0;
      while (src[i + run] === ch) run += 1;
      const before = src[i - 1];
      const after = src[i + run];
      const leftFlanking = after !== undefined && !/\s/.test(after);
      const intraword = ch === "_" && before !== undefined && /[\p{L}\p{N}]/u.test(before);
      if (leftFlanking && !intraword) {
        if (run >= 3) {
          const close = findClosing(scan, i + 3, ch.repeat(3));
          if (close !== -1) {
            nodes.push({ type: "strong", children: [{ type: "em", children: nested(src.slice(i + 3, close)) }] });
            i = close + 3;
            continue;
          }
        }
        if (run >= 2) {
          const close = findClosing(scan, i + 2, ch.repeat(2));
          if (close !== -1) {
            nodes.push({ type: "strong", children: nested(src.slice(i + 2, close)) });
            i = close + 2;
            continue;
          }
        }
        const close = findClosing(scan, i + 1, ch);
        if (close !== -1) {
          nodes.push({ type: "em", children: nested(src.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
      pushText(nodes, src.slice(i, i + run));
      i += run;
      continue;
    }

    pushText(nodes, ch);
    i += 1;
  }
  return nodes;
}

/** Parse one line (or a paragraph's joined lines) of card Markdown into inline nodes. */
export function parseProgressInline(src: string): ProgressInline[] {
  return parseInlineInto(src, { depth: 0, inLink: false });
}

/** The plain words of an inline run — for a one-line summary or an accessible name. */
export function progressInlineText(nodes: ProgressInline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "code":
        out += node.text;
        break;
      case "break":
        out += " ";
        break;
      case "progress":
        if (node.label) out += node.label;
        break;
      default:
        out += progressInlineText(node.children);
    }
  }
  return out.replace(/\s+/g, " ").trim();
}
