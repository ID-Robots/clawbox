/**
 * What a spoken reply says, out of what the assistant wrote.
 *
 * A chat reply is Markdown for a screen: headings, bullets, links, code, the
 * MEDIA: lines a picture rides in on. Read aloud verbatim it is "hash hash",
 * "asterisk", a URL spelled out and a code block nobody can follow by ear. So
 * the words are lifted out of the markup before they go to the voice, and the
 * result is capped — a reply that runs to pages is a document, not a voice
 * note, and the cloud voice bills by the character.
 *
 * Client-safe: no imports, used by the chat and by the speak route alike.
 */

/** The most one spoken reply says; the rest is on screen. */
export const SPEECH_MAX_CHARS = 1500;

/**
 * OpenClaw's rich-render shortcode, `[embed url="…" title="…" /]` (its
 * reference/rich-output-protocol.md): self-closing, values in double or
 * single quotes. Two alternatives: quoted values first, so a title such as
 * "Trailer [HD]" still closes the shortcode, then OpenClaw's own looser
 * `\[embed\s+([^\]]*?)\/\]`. Values are capped in length so a hostile reply
 * cannot make a match scan the whole text from every opener.
 * Here, not in chat-markdown.tsx, because this file has no imports and is
 * read by the speak route too; the chat renderer takes it from here so the
 * screen and the voice agree on what counts as one.
 */
export const EMBED_SHORTCODE_RE =
  /\[embed((?:\s+[A-Za-z_][\w-]*\s*=\s*(?:"[^"]{0,2048}"|'[^']{0,2048}'))+)\s*\/\]|\[embed(\s[^\]]{0,2048}?)\/\]/gi;

/**
 * The tail of a reply still STREAMING that may yet become a shortcode: `[e`
 * up to the closing `/`, attribute by attribute. Anything that cannot grow
 * into one ("[embed shortcode] …") does not match and stays text. Only the
 * renderer's streaming pass uses it: a settled reply is never cut.
 */
export const EMBED_PENDING_RE =
  /\[(?:e|em|emb|embe|embed(?:\s+[A-Za-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'))*(?:\s+[A-Za-z_][\w-]*(?:\s*=\s*(?:"[^"]*|'[^']*)?)?)?\s*\/?)$/i;

/**
 * A shortcode's attributes, blank values dropped. Only the names the chat
 * reads are kept, each written under its own fixed key: the reply is
 * untrusted, so a name out of it is never used as a property name.
 */
export function embedAttributes(raw: string): { url?: string; ref?: string; title?: string } {
  const attrs: { url?: string; ref?: string; title?: string } = {};
  for (const m of raw.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = (m[2] ?? m[3] ?? "").trim();
    if (!value) continue;
    const name = m[1].toLowerCase();
    if (name === "url") attrs.url = value;
    else if (name === "ref") attrs.ref = value;
    else if (name === "title") attrs.title = value;
  }
  return attrs;
}

/**
 * Text with each shortcode reduced to its title, and a half-written one at
 * the very end (a reply still arriving) dropped: neither is ever read out.
 */
export function withoutEmbedShortcodes(text: string): string {
  return text
    .replace(EMBED_SHORTCODE_RE, (_m, quoted?: string, loose?: string) =>
      ` ${embedAttributes(quoted ?? loose ?? "").title ?? ""} `)
    .replace(EMBED_PENDING_RE, " ");
}

export function speechTextFor(markdown: string, maxChars: number = SPEECH_MAX_CHARS): string {
  let text = markdown
    // Directive lines carry nothing to say: `MEDIA:<path>` (chat-media.ts)
    // and `EMAIL:<uid>` (chat-email-refs.ts). Upper case and one token, so
    // a sentence that starts "Email: the invoice went out" is still read.
    .replace(/^\s*MEDIA:.*$/gm, " ")
    .replace(/^\s*EMAIL:\s*\S+\s*$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ");
  // An embed is drawn, not read: its title at most (before the URL rule
  // below would leave the rest of the shortcode behind as words).
  text = withoutEmbedShortcodes(text)
    .replace(/`([^`]*)`/g, "$1")
    // Images become nothing; links become their label.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Bare URLs are unreadable aloud.
    .replace(/https?:\/\/\S+/g, " ")
    // Headings, quotes, bullets, numbering, rules, tables.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, " "))
    // Emphasis markers.
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    // Control characters have no sound and can break a command line.
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (text.length > maxChars) {
    // Cut at a sentence end where there is one in the last stretch, so the
    // voice does not stop mid-word.
    const head = text.slice(0, maxChars);
    const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
    text = (stop > maxChars * 0.6 ? head.slice(0, stop + 1) : head).trim();
  }
  return text;
}
