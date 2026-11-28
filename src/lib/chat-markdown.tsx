import React, { useState } from "react";
import { EMBED_PENDING_RE, EMBED_SHORTCODE_RE, embedAttributes, withoutEmbedShortcodes } from "@/lib/speech-text";

function isSafeHref(url: string): boolean {
  try {
    const parsed = new URL(url, "https://localhost");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * A bare URL the owner (or the model) typed without markdown around it.
 *
 * `[label](url)` was already a link; a pasted `https://…` was not, and the
 * mascot chat is where the agent hands over tunnel links, PR urls and docs.
 * Deliberately narrow: http/https, plus `www.`-prefixed hosts. Bare domains
 * are NOT matched, because chat is full of `index.js`, `page.tsx` and
 * `config.json`, and linkifying those would turn ordinary filenames into
 * broken links.
 */
const BARE_URL_RE = /(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+)/g;

/**
 * Trailing punctuation belongs to the SENTENCE, not the URL — "see https://x.dev."
 * must not link the full stop. Closing brackets are only trimmed when the URL
 * carries no matching opener, so a real `…/Foo_(bar)` wiki-style path survives.
 */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?".includes(ch)) { end--; continue; }
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      const slice = url.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) { end--; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * Plain text with its bare URLs turned into anchors.
 *
 * The attribute is the parsed URL's own `href`, not the matched text: the
 * parser settles the scheme (only http/https get through), and its output is
 * a fresh string the message text never reaches, which is why neither XSS
 * query (js/xss, js/xss-through-dom) tracks the chat input into the
 * attribute — `isSafeHref` answers the same question, but as a boolean about
 * a COPY, and the value it vouched for would still be the text itself.
 * Parsing normalises a little (a bare host gains its trailing slash,
 * non-ASCII path characters are percent-encoded); the browser does exactly
 * that at navigation anyway, and the visible link stays what was pasted.
 */
function linkifyPlain(text: string, keyPrefix: string): React.ReactNode {
  if (!text) return text;
  BARE_URL_RE.lastIndex = 0;
  if (!BARE_URL_RE.test(text)) return text;
  BARE_URL_RE.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const raw = trimUrlTail(m[0]);
    if (!raw) continue;
    const candidate = raw.startsWith("www.") ? `https://${raw}` : raw;
    let href: string;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      href = parsed.href;
    } catch {
      // `https://` with nothing behind it, or a host the parser refuses: not
      // a link. The text stays in the sentence as it was.
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={`${keyPrefix}-url-${m.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#f97316] underline break-all"
      >
        {raw}
      </a>,
    );
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
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
    // Emphasis renders its own contents: `**Gravity `-11`**` reached the bubble
    // with its backticks intact — the one code span on the page drawn as
    // literal text — because the inner string was handed over raw. The
    // recursion is bounded by construction: the split's emphasis patterns are
    // `[^*]+`, so nothing inside one can be emphasis again.
    if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={`${keyPrefix}-${j}`}>{renderInline(seg.slice(2, -2), `${keyPrefix}-${j}`)}</strong>;
    if (seg.startsWith('*') && seg.endsWith('*')) return <em key={`${keyPrefix}-${j}`}>{renderInline(seg.slice(1, -1), `${keyPrefix}-${j}`)}</em>;
    const linkMatch = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = isSafeHref(linkMatch[2]) ? linkMatch[2] : "#";
      return <a key={`${keyPrefix}-${j}`} href={href} target="_blank" rel="noopener noreferrer" className="text-[#f97316] underline">{linkMatch[1]}</a>;
    }
    return <span key={`${keyPrefix}-${j}`}>{linkifyPlain(seg, `${keyPrefix}-${j}`)}</span>;
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
  | { kind: "details"; summary: string; body: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "table"; header: string[] | null; rows: string[][] }
  | { kind: "list"; items: { marker: string; text: string }[] }
  | { kind: "embed"; attrs: Record<string, string> | null }
  | { kind: "para"; lines: string[] };

const FENCE_RE = /^\s*```/;

/**
 * Where an `[embed … /]` (speech-text.ts) starts on this line, and what it is:
 * whole, or — while the reply is still `streaming` — its half-written tail
 * (`attrs: null`, drawn as nothing so it never flashes; a settled reply is
 * never cut). The match may run on over the following lines. An opener inside
 * a closed inline code span is skipped, like a fenced one.
 */
const EMBED_OPENER_RE = /\[embed\s|\[(?:e|em|emb|embe|embed)$/i;
const EMBED_AT_RE = new RegExp(EMBED_SHORTCODE_RE.source, "iy");
const EMBED_PENDING_AT_RE = new RegExp(`^${EMBED_PENDING_RE.source}`, "i");
function findEmbed(lines: string[], i: number, streaming: boolean): { at: number; length: number; attrs: Record<string, string> | null } | null {
  const line = lines[i];
  if (!EMBED_OPENER_RE.test(line)) return null;
  const rest = lines.slice(i).join("\n");
  const opener = /\[e/gi;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(line)) !== null) {
    const ticks = line.slice(0, m.index).split("`").length - 1;
    if (ticks % 2 === 1 && line.indexOf("`", m.index) !== -1) continue;
    const tail = rest.slice(m.index);
    EMBED_AT_RE.lastIndex = 0;
    const whole = EMBED_AT_RE.exec(tail);
    if (whole) return { at: m.index, length: whole[0].length, attrs: embedAttributes(whole[1] ?? whole[2] ?? "") };
    if (streaming && EMBED_PENDING_AT_RE.test(tail)) return { at: m.index, length: tail.length, attrs: null };
  }
  return null;
}

/** The labels an embed card shows; the caller translates them, like `tableLabel`. */
export type EmbedLabels = { play: string; openOnYouTube: string; untitled: string };

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** `90`, `90s`, `1m30s`, `1h2m3s` as whole seconds; anything else is no start. */
function youTubeStart(value: string | null): number | null {
  const m = value?.match(/^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/);
  if (!m || !value) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

/**
 * The video an https YouTube link points at, and its start time. Every other
 * parameter is dropped: the card's URLs are rebuilt from the checked id, never
 * copied from the reply.
 */
function youTubeVideo(url: string): { id: string; start: number | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (host === "youtu.be") {
    if (path.length === 1) id = path[0];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (path.length === 1 && path[0] === "watch") id = parsed.searchParams.get("v") ?? undefined;
    else if (path.length === 2 && ["shorts", "live", "embed"].includes(path[0])) id = path[1];
  } else if (["youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
    if (path.length === 2 && path[0] === "embed") id = path[1];
  }
  if (!id || !YOUTUBE_ID_RE.test(id)) return null;
  const hashT = new URLSearchParams(parsed.hash.slice(1)).get("t");
  const start = youTubeStart(parsed.searchParams.get("start") ?? parsed.searchParams.get("t") ?? hashT);
  return { id, start };
}

/**
 * A YouTube card: thumbnail, title, Play. The player frame is not in the page
 * until Play is pressed (OpenClaw's Control UI does the same), and the watch
 * link is always there for a video that will not play inline.
 */
function YouTubeEmbed(
  { id, start, title, labels, spaced }: { id: string; start: number | null; title: string; labels: EmbedLabels; spaced: boolean },
) {
  const [playing, setPlaying] = useState(false);
  const watch = `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`;
  return (
    <div data-testid="chat-embed-youtube" className={`${spaced ? "mt-2" : ""} w-full max-w-[420px]`}>
      <div className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: "16 / 9" }}>
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ""}`}
            title={title || "YouTube"}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <button
            type="button"
            data-testid="chat-embed-youtube-play"
            onClick={() => setPlaying(true)}
            aria-label={title ? `${labels.play}: ${title}` : labels.play}
            className="absolute inset-0 h-full w-full cursor-pointer border-0 bg-transparent p-0"
          >
            <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" className="h-full w-full object-cover" />
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full bg-black/70 py-1.5 pl-2.5 pr-3.5 text-[13px] font-semibold text-white"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 22 }}>play_arrow</span>
              {labels.play}
            </span>
          </button>
        )}
      </div>
      {title && <div className="mt-1 text-[13px] font-medium">{title}</div>}
      <a href={watch} target="_blank" rel="noopener noreferrer" className="text-xs text-[#f97316] underline">
        {labels.openOnYouTube}
      </a>
    </div>
  );
}

/**
 * One `[embed … /]`, by what it points at. The reply is untrusted text, so the
 * URL decides only WHICH of these is drawn and never reaches markup as typed:
 *   - an https YouTube video: the card above;
 *   - a hosted Canvas document (`ref=`, or a `/__openclaw__/canvas/…` URL): a
 *     titled card. OpenClaw's Control UI fetches those over its authenticated
 *     gateway socket; this chat has no such channel, and framing the path
 *     here would be answered by the gateway catch-all with the Control UI
 *     shell (token and all), or by nothing on Hermes;
 *   - any other https page: its title as an ordinary link, no frame;
 *   - anything else (javascript:, data:, http:, garbage): the title as text.
 */
function EmbedBlock({ attrs, labels, spaced }: { attrs: Record<string, string>; labels: EmbedLabels; spaced: boolean }) {
  const title = attrs.title ?? "";
  const className = spaced ? "mt-2" : "";
  const video = attrs.url ? youTubeVideo(attrs.url) : null;
  if (video) return <YouTubeEmbed id={video.id} start={video.start} title={title} labels={labels} spaced={spaced} />;
  let href: string | null = null;
  let hosted = Boolean(attrs.ref);
  if (attrs.url) {
    try {
      const parsed = new URL(attrs.url, "https://localhost");
      if (parsed.pathname.startsWith("/__openclaw__/canvas/")) hosted = true;
      const absolute = new URL(attrs.url);
      if (absolute.protocol === "https:" && !absolute.username && !absolute.password) href = absolute.href;
    } catch {
      // Not an absolute URL: at most a hosted document, never a link.
    }
  }
  if (hosted) {
    return (
      <div
        data-testid="chat-embed-hosted"
        className={`${className} inline-flex max-w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px]`}
      >
        <span aria-hidden="true" className="material-symbols-rounded text-white/50" style={{ fontSize: 18 }}>widgets</span>
        <span className="font-medium">{title || labels.untitled}</span>
      </div>
    );
  }
  if (href) {
    return (
      <div className={className}>
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#f97316] underline break-all">{title || attrs.url}</a>
      </div>
    );
  }
  return title ? <div className={className}>{title}</div> : null;
}
/**
 * `<details>`, the ONE piece of HTML this renderer admits.
 *
 * OpenClaw agents fold asides — corrections, long tool output, a second
 * opinion — into `<details><summary>…</summary>…</details>`, and OpenClaw's own
 * UI draws them as a disclosure. This renderer printed the tags, so a reply
 * whose interesting half was inside one arrived as a wall of angle brackets.
 *
 * Nothing else is admitted, and nothing is ever handed to `innerHTML`: the tags
 * are CONSUMED here into a block, and the summary and the body go back through
 * this same renderer as text. A `<script>` in the body stays exactly as
 * harmless as it has always been — React prints it.
 */
const DETAILS_OPEN_RE = /<details(?:\s[^>]*)?>/i;
const SUMMARY_RE = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i;

/** How many `<details>` open and close on one line. */
function detailsDelta(line: string): { opens: number; closes: number } {
  return {
    opens: (line.match(/<details(?:\s[^>]*)?>/gi) ?? []).length,
    closes: (line.match(/<\/details\s*>/gi) ?? []).length,
  };
}

/**
 * Where this block's OWN `</details>` sits, or null while it is still streaming.
 *
 * Depth-aware, not "the last close in the run": `detailsDelta` can return to
 * zero inside the first collected line, so the run may hold a complete block
 * AND later markup — `<details>a</details> tail <details>b</details>` on one
 * line. Taking the last close there would cut the body at the SECOND block's
 * end and print the first block's literal `</details>` in the bubble.
 */
function matchingDetailsClose(inner: string): { index: number; length: number } | null {
  const pattern = /<details(?:\s[^>]*)?>|<\/details\s*>/gi;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    if (match[0][1] === "/") {
      if (depth === 0) return { index: match.index, length: match[0].length };
      depth--;
    } else {
      depth++;
    }
  }
  return null;
}

/**
 * Split `<details>…</details>` innards into its summary and its body.
 *
 * A body with no `<summary>` is not a mistake worth dropping the content over —
 * it is what a half-streamed reply looks like — so it keeps the caller's
 * fallback word as its toggle.
 */
function splitDetails(inner: string, fallbackSummary: string): { summary: string; body: string } {
  const match = inner.match(SUMMARY_RE);
  if (!match) return { summary: fallbackSummary, body: inner.trim() };
  return {
    summary: match[1].trim() || fallbackSummary,
    body: inner.slice(match[0].length).trim(),
  };
}
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// A divider needs at least one dash, so a real row of short cells such as
// `| : | : |` is not mistaken for one.
const TABLE_DIVIDER_RE = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;
// Both bullet forms require the space, so `*emphasis*` is never a list item.
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*(\d{1,9})[.)]\s+(.*)$/;

/**
 * An indented line that continues the list item above it.
 *
 * Deliberately narrower than CommonMark's lazy continuation, which lets an
 * unindented line carry on too: a paragraph that simply follows a list at
 * column 0 is far commoner in what models write than a lazy one, and
 * swallowing it would be the worse mistake. A line that starts a block of its
 * own — a fence, a heading, a table row — ends the list as it always did.
 */
function isListContinuation(line: string): boolean {
  if (!line.trim() || !/^\s/.test(line)) return false;
  return !FENCE_RE.test(line) && !HEADING_RE.test(line) && !TABLE_ROW_RE.test(line);
}

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

/** A line that is nothing but a list, heading or quote marker. */
const LONE_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)?\s*$/;

function parseBlocks(text: string, detailsLabel: string, embeds: boolean, streaming: boolean): MdBlock[] {
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

    // `[embed … /]` is its own block, wherever on the line it starts and
    // however many lines its attributes run over. A `<details>` that opens
    // earlier on the line keeps it: its body comes back through here.
    const detailsStart = line.search(DETAILS_OPEN_RE);
    const embed = embeds ? findEmbed(lines, i, streaming) : null;
    if (embed && (detailsStart === -1 || embed.at < detailsStart)) {
      const before = line.slice(0, embed.at);
      if (before.trim()) {
        // The prose before it is scanned as a line of its own, so a bullet or
        // a heading stays one; a bare marker ("- ") was the card's own and goes.
        lines.splice(i, 1, ...(LONE_MARKER_RE.test(before) ? [] : [before.trimEnd()]), line.slice(embed.at));
        i--;
        continue;
      }
      flushPara();
      blocks.push({ kind: "embed", attrs: embed.attrs });
      const consumed = lines.slice(i).join("\n").slice(0, embed.at + embed.length);
      i += consumed.split("\n").length - 1;
      const after = lines[i].slice(consumed.length - consumed.lastIndexOf("\n") - 1).trimStart();
      if (embed.attrs && after) lines.splice(i + 1, 0, after);
      continue;
    }

    // `<details>` is consumed at BLOCK level, like a fence, and for the same
    // reason: its body holds blank lines, lists and code, and splitting on
    // paragraphs first would tear it into pieces with the tags left in them.
    if (detailsStart !== -1) {
      // Prose can share the line with the tag: keep it in the paragraph it
      // belongs to rather than swallowing it into the disclosure.
      const before = line.slice(0, detailsStart);
      if (before.trim()) para.push(before);
      flushPara();
      const collected: string[] = [line.slice(detailsStart)];
      let depth = 0;
      {
        const { opens, closes } = detailsDelta(collected[0]);
        depth = opens - closes;
      }
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        collected.push(lines[i]);
        const { opens, closes } = detailsDelta(lines[i]);
        depth += opens - closes;
      }
      const joined = collected.join("\n");
      const openMatch = joined.match(DETAILS_OPEN_RE);
      const openEnd = (openMatch?.index ?? 0) + (openMatch?.[0].length ?? 0);
      let inner = joined.slice(openEnd);
      // The close that BALANCES the opening tag is this block's own; an inner
      // `<details>` inside it keeps its tags and folds again on the way back
      // through this renderer.
      const close = matchingDetailsClose(inner);
      // An unterminated block is the normal STREAMING shape — the closing tag
      // has not arrived yet — and must fold rather than flash its tags.
      let after = "";
      if (close) {
        after = inner.slice(close.index + close.length);
        inner = inner.slice(0, close.index);
      }
      blocks.push({ kind: "details", ...splitDetails(inner, detailsLabel) });
      // Whatever followed `</details>` on the same line is ordinary text
      // again — unless it opens another block, in which case it is scanned as
      // a line of its own so that one folds too instead of printing its tags.
      if (after.trim()) {
        if (DETAILS_OPEN_RE.test(after) || (embeds && EMBED_OPENER_RE.test(after))) lines.splice(i + 1, 0, after);
        else para.push(after);
      }
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
      // A row holding an `[embed … /]` ends the table and is scanned again.
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]) && !(rowLines.length && embeds && findEmbed(lines, i, streaming))) {
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
        // An item holding an `[embed … /]` ends the list and is scanned again.
        if (items.length && embeds && findEmbed(lines, i, streaming)) break;
        const bullet = lines[i].match(BULLET_RE);
        const ordered = bullet ? null : lines[i].match(ORDERED_RE);
        if (bullet) items.push({ marker: "•", text: bullet[1] });
        else if (ordered) items.push({ marker: `${ordered[1]}.`, text: ordered[2] });
        else if (items.length && isListContinuation(lines[i])) {
          // A hard-wrapped item: the indented rest of the sentence belongs to
          // the bullet (CommonMark). It used to END the list, so "Only a
          // benign" stayed in the bullet and " chunk-size warning (…)" was
          // drawn as its own left-aligned paragraph, leading spaces and all.
          items[items.length - 1].text += ` ${lines[i].trim()}`;
        } else break;
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
 * One `<details>`, as a disclosure.
 *
 * Closed by default and the summary as the toggle, which is what `<details>`
 * means — the aside is an aside. A button with `aria-expanded` rather than the
 * native element, because that is the pattern this chat already uses for the
 * tool record and the reasoning disclosure, and three collapsibles in one
 * bubble should open the same way.
 *
 * `open` lives here, per block, for the reason ReasoningDisclosure keeps its
 * own: which aside is unfolded belongs to the bubble it is in, and lifting it
 * would make appending a turn reshuffle what is open.
 */
function DetailsBlock(
  { summary, body, tableLabel, detailsLabel, embedLabels, streaming, spaced }: {
    summary: string;
    body: string;
    tableLabel: string;
    detailsLabel: string;
    embedLabels: EmbedLabels | undefined;
    streaming: boolean;
    spaced: boolean;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="chat-markdown-details" className={spaced ? "mt-2" : ""}>
      <button
        type="button"
        data-testid="chat-markdown-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-left font-medium text-white/60 cursor-pointer"
        style={{ font: "inherit", fontSize: 12.5, fontWeight: 500 }}
      >
        <span
          aria-hidden="true"
          className="material-symbols-rounded"
          style={{
            fontSize: 16,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
          }}
        >
          chevron_right
        </span>
        <span>{renderInline(summary, "details-summary")}</span>
      </button>
      {open && body && (
        <div data-testid="chat-markdown-details-body" className="mt-1 pl-4 border-l border-white/10">
          {renderText(body, tableLabel, detailsLabel, embedLabels, streaming)}
        </div>
      )}
    </div>
  );
}

/**
 * `tableLabel` names the scroll container a wide table sits in. It arrives from
 * the caller because this module is a pure renderer with no access to `t` —
 * the same way `audioLabel` is handed `t("chat.audioReply")`.
 *
 * `embedLabels` turns on OpenClaw's `[embed … /]` (EmbedBlock): only the
 * assistant's chat bubbles pass them, the surface the shortcode is for.
 * `streaming` says the text is a reply still arriving, so a half-written
 * shortcode at its end is held back instead of flashing.
 */
export function renderText(
  text: string,
  tableLabel = "Table",
  detailsLabel = "Details",
  embedLabels?: EmbedLabels,
  streaming = false,
) {
  return parseBlocks(text, detailsLabel, Boolean(embedLabels), streaming).map((block, i) => {
    // The first block sits flush against the top of the bubble; every later
    // one keeps the spacing its kind had before.
    const spaced = i > 0;
    switch (block.kind) {
      case "code":
        return (
          <pre key={i} className="bg-white/[0.06] rounded-lg px-3 py-2 my-1.5 text-xs overflow-x-auto whitespace-pre-wrap break-words">{block.code}</pre>
        );
      case "details":
        return (
          <DetailsBlock
            key={i}
            summary={block.summary}
            body={block.body}
            tableLabel={tableLabel}
            detailsLabel={detailsLabel}
            embedLabels={embedLabels}
            streaming={streaming}
            spaced={spaced}
          />
        );
      case "embed":
        // A half-streamed shortcode draws nothing until it is whole.
        return block.attrs && embedLabels ? <EmbedBlock key={i} attrs={block.attrs} labels={embedLabels} spaced={spaced} /> : null;
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
  // An `[embed … /]` is drawn, not read: its title at most.
  const flat = withoutEmbedShortcodes(text)
    // The one HTML the renderer consumes (see DETAILS_OPEN_RE): the tags are
    // layout, never words, and read out they are "less than details greater
    // than". The summary and the body stay — they are the aside's own text.
    .replace(/<\/?details(?:\s[^>]*)?>/gi, " ")
    .replace(/<\/?summary(?:\s[^>]*)?>/gi, " ")
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

/**
 * Accessible name for a spoken reply's player.
 *
 * The message body is already on screen and already read by the message
 * itself, so this is a short identifying fragment, not a second copy — but it
 * has to be there: a transcript can hold several players, and "audio" three
 * times over tells a screen-reader user nothing about which is which.
 *
 * Hand it the text as the BUBBLE shows it, never the stored text: directives
 * are lifted at render on both chat surfaces, so the raw string still carries
 * the `EMAIL:` ids and the absolute `MEDIA:` paths a player must not announce.
 *
 * Shared rather than defined beside each player: the mascot chat and the
 * full-screen chat both draw one, and every previous label rule had to be
 * fixed twice.
 */
export function audioLabel(text: string | undefined, prefix: string): string {
  const spoken = text ? plainTextForLabel(text, 100) : "";
  return spoken ? `${prefix}: ${spoken}` : prefix;
}
