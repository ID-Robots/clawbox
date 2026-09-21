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

export function speechTextFor(markdown: string, maxChars: number = SPEECH_MAX_CHARS): string {
  let text = markdown
    // Directive lines carry nothing to say: `MEDIA:<path>` (chat-media.ts)
    // and `EMAIL:<uid>` (chat-email-refs.ts). Upper case and one token, so
    // a sentence that starts "Email: the invoice went out" is still read.
    .replace(/^\s*MEDIA:.*$/gm, " ")
    .replace(/^\s*EMAIL:\s*\S+\s*$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
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
