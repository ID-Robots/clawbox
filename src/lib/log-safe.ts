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

export function logSafe(value: string, maxLength: number = LOG_FIELD_MAX_LENGTH): string {
  if (value.length <= maxLength) return value.replace(CONTROL_CHARACTERS, REPLACEMENT);
  // Cut first, then sanitise the head only. Every character the pattern matches
  // is one UTF-16 code unit replaced by one, so sanitising cannot change any
  // index and no match can straddle the cut — this gives the same string as
  // sanitising the whole value would, without walking a caller-sized input to
  // produce a bounded line. An execFile error message can be a megabyte.
  const head = value.slice(0, maxLength).replace(CONTROL_CHARACTERS, REPLACEMENT);
  return `${head}...[+${value.length - maxLength} chars]`;
}
