/**
 * The "Highlights" of a ClawBox release, read out of its release notes
 * (TASK-1205).
 *
 * ONE parser for both places the notes live: `RELEASE-NOTES-<version>.md` in
 * the checkout and the GitHub release body for the tag, which is the same
 * Markdown pasted (v4.0.0, v4.1.0). Client-safe and pure, so the route, the
 * cache and the tests read the same rules.
 *
 * What it reads is the `## Highlights` section's top-level bullets, in the two
 * shapes the releases have used:
 *
 *   - **More of the phone for the chat.** On a phone the chat opens …   (4.0, 4.1)
 *   - **Hermes edition** — a single-harness SKU locked at install time …  (3.9)
 *
 * A bullet wraps over indented lines; those are joined back into one. Nested
 * bullets are left out — a highlight is a sentence or two, not a tree.
 *
 * What comes out is PLAIN TEXT: bold, code, links and HTML are reduced to their
 * words and each field is capped, because the update screen renders it as text
 * inside a narrow panel and the body came from the network. A release without
 * a Highlights section (the older "What's Changed" PR lists) answers none, and
 * the caller shows its generic line — never a PR list dressed up as highlights.
 */

export interface ReleaseHighlight {
  /** The bold lead of the bullet, without its closing full stop. May be empty. */
  title: string;
  /** The rest of the bullet. May be empty. */
  body: string;
}

/**
 * A panel shows a handful and links to the rest: the update screen's step list
 * stays the thing to read. The 4.1 notes list four, the 4.0 notes eight.
 */
export const MAX_HIGHLIGHTS = 6;
/** Longer than any title the notes have used, short enough for one line or two. */
export const MAX_TITLE_CHARS = 120;
/** Two or three sentences — the longest 4.1 highlight is about 200. */
export const MAX_BODY_CHARS = 360;
/**
 * How much of one bullet's Markdown is read at all. Well past what the capped
 * title and body can show, and a bound on the inline regexes (a lazy match
 * against a back-reference is quadratic in the worst case) for a body that
 * came off the network.
 */
export const MAX_ITEM_SOURCE_CHARS = 4 * (MAX_TITLE_CHARS + MAX_BODY_CHARS);

/** `## Highlights`, `### Highlights`, `## Highlights of 4.1` — any level below the title. */
const HIGHLIGHTS_HEADING = /^#{2,6}\s+highlights\b/i;
const ANY_HEADING = /^#{1,6}\s/;
/** A top-level bullet: `- `, `* ` or `+ ` at column 0 (up to one stray space). */
const TOP_BULLET = /^ ?[-*+]\s+(.*)$/;
/** A bullet nested under another one. */
const NESTED_BULLET = /^\s{2,}[-*+]\s+/;

/** `text` cut to `max` characters at a word boundary where one is near, with an ellipsis. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.—–-]+$/, "")}…`;
}

/**
 * Markdown inline syntax reduced to the words it wraps.
 *
 * Not a Markdown renderer: it removes what the release notes actually use —
 * bold, italics, code spans, links, images, HTML tags and a few entities — so
 * the panel never shows a literal `**` or a raw URL, and nothing in the body
 * can become markup. A code span's content is kept VERBATIM: the 4.0 notes
 * name `<boxHandle>.clawbox.tech`, which is not an HTML tag.
 */
export function plainInline(markdown: string): string {
  const spans: string[] = [];
  const stashed = markdown
    .replace(/\u0000/g, "")
    .replace(/`([^`]*)`/g, (_match, code: string) => `\u0000${spans.push(code) - 1}\u0000`);
  return stashed
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => spans[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One bullet's text split into its bold lead and the rest.
 *
 * `**Title.** body`, `**Title** — body` and `**Title**: body` give a title and a
 * body; a bullet with no bold lead is all body.
 */
export function splitHighlight(text: string): ReleaseHighlight {
  const lead = /^\s*(\*\*|__)([\s\S]+?)\1\s*([\s\S]*)$/.exec(text);
  if (!lead) return { title: "", body: capText(plainInline(text), MAX_BODY_CHARS) };
  const title = plainInline(lead[2]).replace(/[.:]\s*$/, "").trim();
  const body = plainInline(lead[3].replace(/^[\s—–:-]+/, ""));
  return { title: capText(title, MAX_TITLE_CHARS), body: capText(body, MAX_BODY_CHARS) };
}

/**
 * The Highlights of a release, from its notes, in the order they are listed.
 *
 * Never throws; anything that is not a string, or notes without a Highlights
 * section, answer an empty list.
 */
export function parseReleaseHighlights(markdown: unknown, max: number = MAX_HIGHLIGHTS): ReleaseHighlight[] {
  if (typeof markdown !== "string" || !markdown) return [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => HIGHLIGHTS_HEADING.test(line.trim()));
  if (start < 0) return [];

  const items: string[] = [];
  let current: string[] | null = null;
  let skippingNested = false;
  const flush = () => {
    if (current) items.push(current.join(" "));
    current = null;
  };

  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break;
    if (!line.trim()) {
      skippingNested = false;
      continue;
    }
    const bullet = TOP_BULLET.exec(line);
    if (bullet) {
      flush();
      skippingNested = false;
      current = [bullet[1]];
      continue;
    }
    if (NESTED_BULLET.test(line)) {
      skippingNested = true;
      continue;
    }
    // An indented continuation of the bullet above (or of a nested one, which
    // is skipped with it). A paragraph after the list ends the section's list.
    if (/^\s/.test(line)) {
      if (current && !skippingNested) current.push(line.trim());
      continue;
    }
    if (current) flush();
    if (items.length) break;
  }
  flush();

  return items
    .slice(0, Math.max(0, max) * 4)
    .map((text) => splitHighlight(text.slice(0, MAX_ITEM_SOURCE_CHARS)))
    .filter((item) => item.title || item.body)
    .slice(0, Math.max(0, max));
}
