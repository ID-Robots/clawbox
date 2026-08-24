import React from "react";

function isSafeHref(url: string): boolean {
  try {
    const parsed = new URL(url, "https://localhost");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((seg, j) => {
    if (seg.startsWith('```') && seg.endsWith('```')) {
      const code = seg.slice(3, -3).replace(/^\w*\n/, '');
      return <pre key={`${keyPrefix}-${j}`} className="bg-white/[0.06] rounded-lg px-3 py-2 my-1.5 text-xs overflow-x-auto whitespace-pre-wrap break-words">{code}</pre>;
    }
    if (seg.startsWith('`') && seg.endsWith('`')) {
      return <code key={`${keyPrefix}-${j}`} className="bg-white/[0.08] rounded px-1.5 py-px text-[0.9em]">{seg.slice(1, -1)}</code>;
    }
    if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={`${keyPrefix}-${j}`}>{seg.slice(2, -2)}</strong>;
    if (seg.startsWith('*') && seg.endsWith('*')) return <em key={`${keyPrefix}-${j}`}>{seg.slice(1, -1)}</em>;
    const linkMatch = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = isSafeHref(linkMatch[2]) ? linkMatch[2] : "#";
      return <a key={`${keyPrefix}-${j}`} href={href} target="_blank" rel="noopener noreferrer" className="text-[#f97316] underline">{linkMatch[1]}</a>;
    }
    return <span key={`${keyPrefix}-${j}`}>{seg}</span>;
  });
}

/**
 * One markdown block. `renderText` walks LINES to build these, rather than
 * regex-matching whole paragraphs.
 *
 * The paragraph-matching version dropped content. It split the reply on blank
 * lines and, when a chunk started with `##`, returned ONLY the heading —
 * `/^##\s+(.+)/` stops at the first newline because `.` does not match one.
 * A block shaped like
 *
 *     ## Hardware
 *     | **CPU** | 6x Cortex-A78AE |
 *
 * — a heading and its body separated by a SINGLE newline, which is the normal
 * shape models emit — therefore rendered as the word "Hardware" and nothing
 * else. Observed live: a stored 1429-character reply reached the bubble as
 * five headings, with every table, list and sentence under them discarded.
 * The streaming and storage sides were correct; only this file lost the text.
 *
 * Walking lines fixes that by construction: a heading block ENDS at its line,
 * so whatever follows becomes its own block instead of being swallowed.
 */
type MdBlock =
  | { kind: "code"; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "table"; header: string[] | null; rows: string[][] }
  | { kind: "list"; items: { marker: string; text: string }[] }
  | { kind: "para"; lines: string[] };

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// A divider needs at least one dash, so a real row of short cells such as
// `| : | : |` is not mistaken for one.
const TABLE_DIVIDER_RE = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;
// Both bullet forms require the space, so `*emphasis*` is never a list item.
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*(\d{1,9})[.)]\s+(.*)$/;

/**
 * Cells of one table row, without the outer pipes.
 *
 * Splitting on a bare `|` would cut inside `` `a | b` `` and on an escaped
 * `\|`, both of which models do emit inside cells.
 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocks(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "para", lines: para });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fences are consumed at BLOCK level so a blank line inside one survives.
    // Splitting on blank lines first tore such a block in two and rendered the
    // halves as prose with stray backticks.
    if (FENCE_RE.test(line)) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // `i` rests on the closing fence (or past the end); the loop steps over it.
      blocks.push({ kind: "code", code: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (TABLE_ROW_RE.test(line)) {
      const rowLines: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rowLines.push(lines[i]);
        i++;
      }
      i--; // the loop's own step lands on the first line after the table
      let header: string[] | null = null;
      let bodyLines = rowLines;
      if (rowLines.length > 1 && TABLE_DIVIDER_RE.test(rowLines[1])) {
        header = splitTableRow(rowLines[0]);
        bodyLines = rowLines.slice(2);
      }
      bodyLines = bodyLines.filter((l) => !TABLE_DIVIDER_RE.test(l));
      if (header || bodyLines.length) {
        flushPara();
        blocks.push({ kind: "table", header, rows: bodyLines.map(splitTableRow) });
      } else {
        // Nothing but dividers — not a table anyone meant. Keep the text.
        para.push(...rowLines);
      }
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      flushPara();
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length) {
        const bullet = lines[i].match(BULLET_RE);
        const ordered = bullet ? null : lines[i].match(ORDERED_RE);
        if (bullet) items.push({ marker: "•", text: bullet[1] });
        else if (ordered) items.push({ marker: `${ordered[1]}.`, text: ordered[2] });
        else break;
        i++;
      }
      i--;
      blocks.push({ kind: "list", items });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}

/**
 * `tableLabel` names the scroll container a wide table sits in. It arrives from
 * the caller because this module is a pure renderer with no access to `t` —
 * the same way `audioLabel` is handed `t("chat.audioReply")`.
 */
export function renderText(text: string, tableLabel = "Table") {
  return parseBlocks(text).map((block, i) => {
    // The first block sits flush against the top of the bubble; every later
    // one keeps the spacing its kind had before.
    const spaced = i > 0;
    switch (block.kind) {
      case "code":
        return (
          <pre key={i} className="bg-white/[0.06] rounded-lg px-3 py-2 my-1.5 text-xs overflow-x-auto whitespace-pre-wrap break-words">{block.code}</pre>
        );
      case "heading":
        return block.level <= 2 ? (
          <h2 key={i} className={`font-bold text-sm ${spaced ? "mt-2.5" : ""} mb-1`}>{renderInline(block.text, `h-${i}`)}</h2>
        ) : (
          <h3 key={i} className={`font-semibold text-[13.5px] ${spaced ? "mt-2" : ""} mb-0.5`}>{renderInline(block.text, `h-${i}`)}</h3>
        );
      case "table":
        return (
          // The bubble is narrow and capped at 85% of the thread, so a wide
          // table has to scroll INSIDE itself; letting it set the bubble's
          // width would push the whole popup out of shape.
          // A region that scrolls needs its own tab stop, or a keyboard-only
          // reader cannot reach the columns past the right edge (WCAG 2.1.1).
          // Focusable means it also needs a name, hence the label.
          <div
            key={i}
            role="region"
            aria-label={tableLabel}
            tabIndex={0}
            className={`${spaced ? "mt-2" : ""} max-w-full overflow-x-auto`}
          >
            <table className="w-full text-xs border-collapse">
              {block.header && (
                <thead>
                  <tr>
                    {block.header.map((cell, ci) => (
                      <th key={ci} className="text-left font-semibold px-2 py-1 border-b border-white/20 align-top">{renderInline(cell, `t-${i}-h-${ci}`)}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-2 py-1 border-b border-white/[0.08] align-top">{renderInline(cell, `t-${i}-${ri}-${ci}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list":
        return (
          <div key={i} className="my-1 pl-1">
            {block.items.map((item, li) => (
              <div key={li} className="flex gap-1.5 mb-0.5">
                <span className="opacity-40">{item.marker}</span>
                <span>{renderInline(item.text, `${i}-${li}`)}</span>
              </div>
            ))}
          </div>
        );
      default:
        return (
          <div key={i} className={spaced ? "mt-2" : ""}>
            {block.lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(line, `${i}-${li}`)}
              </span>
            ))}
          </div>
        );
    }
  });
}

/**
 * The same message as plain speech, for an accessible name.
 *
 * A control's accessible name is read aloud verbatim, so the markdown source
 * cannot go in it: `*"seventeen copper bells"*` is announced as "asterisk
 * quote seventeen copper bells quote asterisk", and a fenced block reads its
 * backticks out one by one. The audio player's label was the raw `msg.text`,
 * so every emphasis mark, link URL and heading hash in a spoken reply landed
 * in the screen reader.
 *
 * Deliberately in this file and not next to the player: it strips the same
 * markers `renderInline`/`renderText` consume, so the two cannot drift into
 * disagreeing about what counts as markup. Where it differs it strips MORE,
 * never less: `renderText` only promotes `##`/`###` to headings and only
 * bullets a paragraph made entirely of them, while this drops any leading
 * `#`s and any leading bullet. That asymmetry is the safe one — a stray `#`
 * that stays on screen costs nothing, but spoken aloud it is just noise.
 *
 * `max` is a budget for the SPOKEN name, so it cuts on a word boundary — the
 * previous `slice(0, 100)` could stop mid-word, and mid-token, which is worse
 * out loud than it looks on screen.
 */
export function plainTextForLabel(text: string, max = 100): string {
  const flat = text
    // Fenced blocks first: their content may contain any other marker.
    .replace(/```[\s\S]*?```/g, (seg) => seg.slice(3, -3).replace(/^\w*\n/, ""))
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    // Headings and list bullets are line-leading, so anchor them per line.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    // Tables, since renderText draws them as real tables. A `|---|---|` divider
    // is pure layout and says nothing out loud, so it goes entirely; the cell
    // walls of a real row become spaces, or the label is read as "pipe CPU
    // pipe 6x Cortex-A78AE pipe".
    .replace(/^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/gm, " ")
    // Reusing splitTableRow is what keeps the walls in step with the table on
    // screen: it knows `\|` is an escaped pipe and belongs in the cell, where
    // splitting on a bare `|` left the backslash behind to be read out loud.
    // Inline code is already unwrapped by the time we reach here, so a pipe
    // that was inside `` ` `` does separate cells in the label — which is the
    // quieter reading anyway, and the pipe itself is never spoken either way.
    .replace(/^\s*\|.*\|\s*$/gm, (row) => ` ${splitTableRow(row).join(" ")} `)
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour the word boundary if one exists late enough to leave a useful
  // label; a single very long token still gets truncated rather than dropped.
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
