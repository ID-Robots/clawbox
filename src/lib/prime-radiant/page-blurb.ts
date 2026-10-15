/**
 * A page in a few sentences, for the Map's card: the frontmatter's own
 * `summary` or `description` when it has one, else the first paragraph of
 * prose in the body — headings, lists, tables, quotes and code passed over,
 * Markdown taken out — cut at the last sentence end within
 * {@link BLURB_MAX} characters. Null when the page has no prose at all.
 *
 * Pure.
 */

export const BLURB_MAX = 400;
/** A cut earlier than this would say too little: the text is cut at a word instead. */
const MIN_CUT = 120;

/** Lines that open something other than prose. */
const NOT_PROSE = /^\s{0,3}(?:#{1,6}(?:\s|$)|```|~~~|\||[-*+]\s|\d+[.)]\s|>|<!--|!\[|(?:-\s*){3,}$|(?:\*\s*){3,}$|(?:_\s*){3,}$|\[\^[^\]]+\]:)/;
const SETEXT = /^\s{0,3}(?:=+|-+)\s*$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/** Markdown out of one paragraph: links and wikilinks become their words, emphasis and tags go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) =>
      (alias?.trim() || (target.split("/").pop() ?? target).replace(/\.md$/i, "").replace(/[-_]+/g, " ")).trim(),
    )
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_](?=\S)/g, "$1")
    .replace(/(\S)[*_](?=$|[\s.,;:!?)])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first paragraph of prose in a page body, as plain text, or null. */
export function firstProse(body: string): string | null {
  const lines = body.split(/\r?\n/);
  let fenced = false;
  let para: string[] = [];
  const flush = (): string | null => {
    const block = para;
    para = [];
    if (block.length === 0 || NOT_PROSE.test(block[0])) return null;
    // "Title\n=====": a heading, not a paragraph.
    if (block.length > 1 && SETEXT.test(block[block.length - 1])) return null;
    const text = plainText(block.join(" "));
    return text === "" ? null : text;
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      const found = fenced ? null : flush();
      if (found) return found;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === "") {
      const found = flush();
      if (found) return found;
      continue;
    }
    // A heading is a block of its own: it ends the paragraph before it, and the line after it starts one.
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) {
      const found = flush();
      if (found) return found;
      continue;
    }
    para.push(line);
  }
  return fenced ? null : flush();
}

/** `text` cut to at most {@link BLURB_MAX} characters, at a sentence end where one is near enough. */
export function cutAtSentence(text: string, max = BLURB_MAX): string {
  if (text.length <= max) return text;
  let cut = -1;
  for (const m of text.slice(0, max + 1).matchAll(/[.!?…](?:["'”’)\]]*)(?=\s|$)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end <= max) cut = end;
  }
  if (cut >= MIN_CUT) return text.slice(0, cut);
  const space = text.lastIndexOf(" ", max - 1);
  return `${text.slice(0, space > MIN_CUT ? space : max - 1).replace(/[\s,;:–—-]+$/, "")}…`;
}

/** What the Map's card says about a page (see the module comment). */
export function pageBlurb(frontmatter: Record<string, unknown> | null, body: string): string | null {
  for (const key of ["summary", "description"]) {
    const value = frontmatter?.[key];
    if (typeof value === "string") {
      const text = plainText(value);
      if (text !== "") return cutAtSentence(text);
    }
  }
  const prose = firstProse(body);
  return prose === null ? null : cutAtSentence(prose);
}
