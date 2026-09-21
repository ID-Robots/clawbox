/**
 * Prepare an untrusted string for a log line.
 *
 * Two rules, both about the shape of the record rather than its content:
 *
 *  - one value stays one line. Control characters are replaced, so a value
 *    carrying CR/LF cannot become extra log records, and one carrying ESC is
 *    read as text by a terminal rather than acted on as an escape sequence.
 *  - the record's size does not follow its input's. A long value is cut to
 *    `maxLength` with a count of what was dropped, so the caller of an API does
 *    not decide how much gets written per call. This half is not a nicety:
 *    capping the field is what keeps a stream of these lines bounded.
 *
 * Takes a string, not `unknown` — an `Error` or a plain object formats itself
 * in ways the caller should choose.
 */

// \p{Cc} is the Unicode "control" category: the C0 range, DEL, and C1.
// Replaced rather than stripped, so two values differing only in control
// characters do not collapse into the same log line.
//
// Use it with .replace only. String.replace resets a global pattern's
// lastIndex, so it is stateless here; .test on the same object would not be.
const CONTROL_CHARACTERS = /\p{Cc}/gu;

// U+FFFD REPLACEMENT CHARACTER — the conventional stand-in for a character that
// cannot be shown. Written by code point rather than as a literal so the glyph
// does not read as mojibake in an editor.
const REPLACEMENT = String.fromCharCode(0xfffd);

/** Default cap for a single logged field. */
export const LOG_FIELD_MAX_LENGTH = 200;

// The line breaks are replaced ahead of the control class, each spelled out as
// its own one-character literal, written inline at the call.
//
// CR and LF are already inside `\p{Cc}`, so these two passes change nothing
// about the output — they change who can READ the guarantee. `js/log-injection`
// treats a global `.replace()` as a sanitiser only where it can resolve the
// pattern to the constant "\n" or "\r". A Unicode property escape is not a
// constant, so with `\p{Cc}` alone the scanner judged `logSafe` an unrelated
// branch and every caller kept its alert.
//
// TASK-1014's first attempt spelled the pair as one character class,
// `/[\r\n]/g`, behind a named constant. That reads to a human exactly like the
// two passes below and to the scanner like nothing at all — a class is not a
// constant either — so alerts 566 and 567 both stayed open, their taint path
// stepping straight through the call. One break per literal, written inline,
// is a shape the scanner does read: 567 went to `fixed` on it. Hence the
// pattern is not folded back into a constant or a class, however much tidier
// that would look.
//
// It is not, however, a licence to stop thinking at the call site. The same
// run left 566 standing over a line that passed BOTH of its values through
// here, and that one had to be answered where it was written — the browser
// route now logs the rebuilt path it saved to, instead of repeating the
// caller's own run id beside it. This helper is the floor for a log record,
// not the proof of one.
export function logSafe(value: string, maxLength: number = LOG_FIELD_MAX_LENGTH): string {
  if (value.length <= maxLength) {
    return value
      .replace(/\n/g, REPLACEMENT)
      .replace(/\r/g, REPLACEMENT)
      .replace(CONTROL_CHARACTERS, REPLACEMENT);
  }
  // Cut first, then sanitise the head only. Every character the patterns match
  // is one UTF-16 code unit replaced by one, so sanitising cannot change any
  // index and no match can straddle the cut — this gives the same string as
  // sanitising the whole value would, without walking a caller-sized input to
  // produce a bounded line. An execFile error message can be a megabyte.
  const head = value
    .slice(0, maxLength)
    .replace(/\n/g, REPLACEMENT)
    .replace(/\r/g, REPLACEMENT)
    .replace(CONTROL_CHARACTERS, REPLACEMENT);
  return `${head}...[+${value.length - maxLength} chars]`;
}
