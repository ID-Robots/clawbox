/**
 * What a reply says out loud when the owner asked for SHORT spoken answers
 * (Settings → Voice → "Short spoken answers").
 *
 * A spoken reply is otherwise the whole reply read out (speech-text.ts): every
 * step, caveat and explanation the screen is better at. With short answers
 * on, the voice says the answer — the first one to three sentences, never more
 * than SHORT_SPEECH_MAX_CHARS — and the written reply stays on screen exactly
 * as it was written. Nothing here edits a bubble.
 *
 * The words are picked out of the reply itself, with no model call: no extra
 * turn to pay for or wait on, and the pick can be made while the reply is
 * still streaming, so the voice can start before the text has finished. The
 * alternative — asking the agent to open its reply with a
 * `[[tts:text]]…[[/tts:text]]` summary — needs a way to tell the CHAT's agent,
 * and only the chat's, to write one. ClawBox has none: the chat sends the
 * owner's words and nothing else (`chat.send` / `prompt.submit`), and the
 * places that do reach the agent (AGENTS.md, the MCP server's instructions,
 * OpenClaw's `tts.auto: "tagged"`) reach Telegram and every other channel
 * too. A request riding in the message text would stay in the transcript and
 * the model's context long after the switch went off. So nothing parses a
 * `[[tts:text]]` block here.
 *
 * How the answer is found, in a reply's Markdown:
 *  - Prose only. Code blocks and tables are never spoken, headings are dropped,
 *    and the rest is lifted out of its markup by speechTextFor — links become
 *    their label, URLs, MEDIA: and EMAIL: lines and emphasis go.
 *  - The answer ends where the first code block, table or heading starts, if
 *    something worth saying came before it: what follows is the detail. A
 *    reply that OPENS with one ("Here is the fix:", the code, then what it
 *    does) skips it, and the line that only introduced it — which is still
 *    said when the reply has nothing else to say.
 *  - Sentences end at . ! ? … (and 。！？) and at the end of a line — a bullet
 *    or a short line is a sentence of its own. "e.g." and "Dr." are not ends.
 *  - Up to SHORT_SPEECH_MAX_SENTENCES of them, while they fit in
 *    SHORT_SPEECH_MAX_CHARS. A first sentence longer than that is cut at a
 *    comma or a space. A last sentence ending in ":" introduced something not
 *    spoken, and is left out.
 *
 * For ChatPopup, with the switch on (the plain path stays speechTextFor):
 *  - each streamed delta: `shortSpeechTextFromStream(textSoFar)`. The first
 *    time it answers a string, speak that string and count the reply as
 *    spoken — it is exactly what shortSpeechTextFor will answer for the
 *    finished reply, so there is nothing to say again when the final lands.
 *  - the final reply, if the stream never settled (a short reply, a reply that
 *    arrived whole): `shortSpeechTextFor(text)`. "" means nothing to say,
 *    exactly as speechTextFor's "" does.
 * The speak route runs its own speechTextFor over what it is sent; the short
 * text passes through that unchanged.
 *
 * Client-safe: its only import is speech-text.ts, which has none.
 */
import { speechTextFor } from "@/lib/speech-text";

/** The most a short spoken answer says, in characters. */
export const SHORT_SPEECH_MAX_CHARS = 300;

/** The most sentences a short spoken answer says. */
export const SHORT_SPEECH_MAX_SENTENCES = 3;

/**
 * How far a sentence still being streamed must already run past the room left
 * before it counts as too long to fit. The end of a streamed reply can still
 * lose a few characters it shows now — "MEDIA" that becomes a hidden MEDIA:
 * line, a list marker that becomes nothing, "https://" that becomes a URL —
 * and none of that is anywhere near this long.
 */
const STREAM_SLACK_CHARS = 24;

/**
 * The short spoken text of a FINISHED reply: "" when it has nothing to say
 * (it was all code, or all pictures).
 */
export function shortSpeechTextFor(reply: string): string {
  return shortAnswer(reply, true).text;
}

/**
 * The short spoken text of a reply still STREAMING, once it is settled; null
 * while it is not.
 *
 * `textSoFar` is the whole reply as streamed so far (the bubble's current
 * text), not the latest delta. Settled means nothing that can still arrive
 * could change it: the answer's sentences are all in, or a code block, table
 * or heading has started after them, or the next sentence is already too long
 * to fit. A string returned here is the string shortSpeechTextFor answers for
 * any finished reply that begins with `textSoFar`; never "".
 */
export function shortSpeechTextFromStream(textSoFar: string): string | null {
  const { text, settled } = shortAnswer(textSoFar, false);
  return settled && text ? text : null;
}

function shortAnswer(markdown: string, finished: boolean): { text: string; settled: boolean } {
  const { prose, ended } = answerProse(markdown, finished);
  const { picked, settled } = pickSentences(sentencesOf(spokenWords(ended ? prose : settledProse(prose))), ended);
  if (picked.length > 1 && picked[picked.length - 1].endsWith(":")) picked.pop();
  return { text: spoken(picked), settled: ended || settled };
}

// OpenClaw's reply tags (`[[reply_to_current]]`, `[[reply_to:<id>]]`,
// `[[audio_as_voice]]`) ride at the head of a reply and are not words.
const REPLY_TAG = /\[\[\s*(?:reply_to_current|audio_as_voice|reply_to\s*:\s*[^\]\s]*)\s*\]\]/g;
const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW = /^\s*\|/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
// A line still being written that may yet open a code block ("``") or a
// heading ("##") — or turn out to be prose ("#42 is fixed").
const UNDECIDED_START = /^\s*(?:`{1,2}|~{1,2}|#{1,6})$/;

type LineKind = "prose" | "fence" | "table" | "heading" | "undecided";

function lineKind(line: string, beingWritten: boolean): LineKind {
  if (FENCE.test(line)) return "fence";
  if (TABLE_ROW.test(line)) return "table";
  if (beingWritten && UNDECIDED_START.test(line)) return "undecided";
  if (HEADING.test(line)) return "heading";
  return "prose";
}

/**
 * The Markdown the answer is read from, and whether it is `ended` — whether
 * anything that can still arrive could add to it.
 */
function answerProse(markdown: string, finished: boolean): { prose: string; ended: boolean } {
  const lines = markdown.replace(REPLY_TAG, "").replace(/\r\n?/g, "\n").split("\n");
  let prose: string[] = [];
  // The first line that introduced a skipped block. Said only by a finished
  // reply that has nothing else to say — "Run this:" and a command — which
  // would otherwise be silent where the whole-reply voice says the line.
  let introduction = "";
  const rest = (): { prose: string; ended: boolean } => {
    const tail = prose.join("\n");
    return { prose: finished && !spokenWords(tail) ? introduction : tail, ended: finished };
  };
  for (let i = 0; i < lines.length; i++) {
    // The last line of a reply still streaming is still being written.
    const kind = lineKind(lines[i], !finished && i === lines.length - 1);
    if (kind === "prose") {
      prose.push(lines[i]);
      continue;
    }
    if (kind === "undecided") return { prose: prose.join("\n"), ended: false };
    if (hasSomethingToSay(prose.join("\n"))) return { prose: prose.join("\n"), ended: true };
    // Nothing worth saying before it, but perhaps the line that introduced
    // it ("Here is the fix:"), which goes with it.
    if (!introduction && spokenWords(prose.join("\n"))) introduction = prose.join("\n");
    prose = [];
    if (kind === "fence") {
      const close = closingFence(lines, i);
      // Unclosed: in a finished reply the rest is code; in a streaming one,
      // whatever follows the block has not arrived yet.
      if (close < 0) return rest();
      i = close;
    } else if (kind === "table") {
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1])) i++;
    }
  }
  return rest();
}

function closingFence(lines: string[], open: number): number {
  const marker = FENCE.exec(lines[open])?.[1] ?? "```";
  for (let i = open + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length >= marker.length && [...line].every((c) => c === marker[0])) return i;
  }
  return -1;
}

function hasSomethingToSay(prose: string): boolean {
  return sentencesOf(spokenWords(prose)).some((sentence) => !sentence.endsWith(":"));
}

/**
 * A streaming reply's prose up to the first markup still being written. Until
 * it closes, it is not known what it is: a "```" in the middle of a line may
 * pair with one that has not arrived and take everything between them away
 * (speechTextFor), and a "[label]" may yet become a link. Single backticks
 * need no such care — they go whichever way they pair (spokenWords).
 */
function settledProse(prose: string): string {
  for (;;) {
    let cut = prose;
    const unpaired = cut.replace(/```[\s\S]*?```/g, (span) => " ".repeat(span.length)).indexOf("```");
    if (unpaired >= 0) cut = cut.slice(0, unpaired);
    const link = unfinishedLinkAt(cut);
    if (link >= 0) cut = cut.slice(0, link);
    if (cut === prose) return prose;
    prose = cut;
  }
}

/**
 * Where the first link or image still being written starts; -1 when none is.
 * That is a "[" whose "]" has not arrived, whose "]" is the last character
 * (a "(" may follow), or whose "](" has no ")" after it yet — the three ways
 * speechTextFor's link rules can still go either way.
 */
function unfinishedLinkAt(text: string): number {
  // The first "[" whose first "]" after it is the one at `close`.
  const openerOf = (close: number): number => {
    const open = text.indexOf("[", text.lastIndexOf("]", close - 1) + 1);
    return open >= 0 && open < close ? open : -1;
  };
  const openers = [openerOf(text.length)];
  if (text.endsWith("]")) openers.push(openerOf(text.length - 1));
  const target = text.indexOf("](", text.lastIndexOf(")") + 1);
  if (target >= 0) openers.push(openerOf(target));
  const open = Math.min(...openers.filter((at) => at >= 0));
  if (!Number.isFinite(open)) return -1;
  return open > 0 && text[open - 1] === "!" ? open - 1 : open;
}

// Pictographs and the joiners that build them: an engine that knows them says
// "check mark button", and one that does not says nothing useful.
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;
const MAIL_OR_MEDIA_LINE = /^\s*(?:MEDIA|EMAIL):/;
const ENDS_A_SENTENCE = /[.!?…:;。！？]["'”’»」』)\]]*$/u;

/** The prose's words, one line per line of speech, with no markup left. */
function spokenWords(prose: string): string {
  const words = speechTextFor(
    joinWrappedLines(prose)
      // A bare URL goes, but not the ")." that closed the sentence around it,
      // which speechTextFor's own rule would take with it.
      .replace(/https?:\/\/\S+/g, (url) => url.slice(withoutTrailing(url, ")]}.,;:!?'\"").length))
      // snake_case reads as its words, not as an emphasis marker pair.
      .replace(/([\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, "$1 "),
    Number.POSITIVE_INFINITY,
  );
  return words
    // Emphasis markers and backticks speechTextFor could not pair — one whose
    // partner has not streamed in yet among them — and strikethrough's.
    .replace(/[*_`]+/g, "")
    .replace(/~~/g, "")
    .replace(PICTOGRAPH, "")
    .split("\n")
    .map((line) => line
      // Task-list boxes, which outlive the bullet they followed.
      .replace(/^\[[ xX]\]/, "")
      .replace(/[ \t]+/g, " ")
      // What a removed URL leaves: "(see )", and a space before the stop.
      .replace(/\((?:see)? ?\)/gi, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ ([.,;:!?])/g, "$1")
      .trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * A line that carries on the sentence before it — a hard-wrapped paragraph —
 * joined back onto it: the previous line has words and no end mark, and this
 * one starts in lower case.
 */
function joinWrappedLines(prose: string): string {
  const out: string[] = [];
  for (const line of prose.split("\n")) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined
      && /^\s*\p{Ll}/u.test(line)
      && /[\p{L}\p{N}]/u.test(previous)
      && !MAIL_OR_MEDIA_LINE.test(previous)
      && !ENDS_A_SENTENCE.test(previous.trimEnd())
    ) {
      out[out.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// An end mark followed by a space (so "3.14" and "v1.2" are not ends), a CJK
// end mark (which takes no space), or the end of a line.
const SENTENCE_END = /[.!?…]+["'”’»)\]]*(?=\s)|[。！？]+["'”’»」』)\]]*(?![”’»」』)\]"'])|\n/gu;
const ABBREVIATION = /^["'(]*(?:\p{L}(?:\.\p{L})+|mr|mrs|ms|dr|prof|sr|jr|st|vs|cf|approx|incl|ca|nr|bzw|fig)\.$/iu;

function sentencesOf(words: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const end of words.matchAll(SENTENCE_END)) {
    const at = end.index ?? 0;
    if (end[0].startsWith(".")) {
      // "e.g." and "Dr." end a word, not a sentence.
      const before = words.slice(start, at + 1);
      if (ABBREVIATION.test(before.slice(lastSpace(before) + 1))) continue;
    }
    const sentence = words.slice(start, at + end[0].length).trim();
    if (sentence) sentences.push(sentence);
    start = at + end[0].length;
  }
  const rest = words.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

function lastSpace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) if (/\s/.test(text[i])) return i;
  return -1;
}

/**
 * The answer's sentences, and whether the pick is `settled`: whether a later
 * sentence could still join it. `lastIsWhole` is false while the reply
 * streams, when its last sentence may still be growing.
 */
function pickSentences(sentences: string[], lastIsWhole: boolean): { picked: string[]; settled: boolean } {
  const picked: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (picked.length === SHORT_SPEECH_MAX_SENTENCES) return { picked, settled: true };
    const whole = lastIsWhole || i < sentences.length - 1;
    const length = spoken([...picked, sentences[i]]).length;
    if (length <= SHORT_SPEECH_MAX_CHARS) {
      if (!whole) return { picked, settled: false };
      picked.push(sentences[i]);
      continue;
    }
    // Too long to fit — or, while it is still being written, not yet surely.
    if (!whole && length <= SHORT_SPEECH_MAX_CHARS + STREAM_SLACK_CHARS) return { picked, settled: false };
    if (picked.length === 0) picked.push(clipped(sentences[i]));
    return { picked, settled: true };
  }
  return { picked, settled: picked.length === SHORT_SPEECH_MAX_SENTENCES };
}

/**
 * The sentences as one line to say: a line with no end mark of its own (a
 * bullet, a short line) gets a full stop, so the voice falls at its end
 * rather than running on into the next, and the last one always ends on one.
 */
function spoken(sentences: string[]): string {
  return sentences.map((sentence, i) => {
    const last = i === sentences.length - 1;
    if (/[.!?…。！？]["'”’»」』)\]]*$/u.test(sentence) || (!last && sentence.endsWith(":"))) return sentence;
    return `${withoutTrailing(sentence, ",;:–—- ")}.`;
  }).join(" ");
}

/**
 * The longest head of a sentence too long to say whole that fits, cut at a
 * clause where there is one in its second half and at a space otherwise.
 */
function clipped(sentence: string): string {
  const room = SHORT_SPEECH_MAX_CHARS - 1; // and the full stop
  const head = sentence.slice(0, room + 1);
  let at = Math.max(...[", ", "; ", ": ", " – ", " — ", " - "].map((mark) => head.lastIndexOf(mark)));
  if (at < room / 2) at = head.lastIndexOf(" ");
  if (at <= 0) at = room;
  // Never between the halves of a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(sentence[at - 1] ?? "")) at--;
  return `${withoutTrailing(sentence.slice(0, at), ",;:–—- ")}.`;
}

function withoutTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}
