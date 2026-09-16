/**
 * The last gate between a failed API call and a sentence the owner reads.
 *
 * THE BUG THIS EXISTS FOR. A ClawBox AI device-code sign-in that failed its
 * credential migration put this on the wizard, verbatim, as the error:
 *
 *     {"error":"Credential migration failed. The subscription sign-in was
 *     rolled back — try again, or run 'openclaw doctor --fix' from the
 *     Terminal."}
 *
 * The sentence inside it was fine. What reached the screen was the whole JSON
 * body, because one hop in the chain read the response with `.text()` and
 * passed the string on as if it were a message. Braces and quotes on a setup
 * wizard are a bug report the owner cannot file and cannot act on.
 *
 * WHY A SHARED FUNCTION rather than a fix at the one hop. The body crosses four
 * boundaries between the route that produced it and the paragraph that shows
 * it — `configure` → `clawai/poll` → the poll hook → the step's status line —
 * and any of them can be handed a body by a route that has not been read
 * recently. Each of them calling the same function is what makes "the wizard
 * never renders a raw JSON body" a property of the wizard rather than a
 * property of one code path that was audited once.
 *
 * THE RULE, and it is deliberately one-way: this function returns a sentence or
 * it returns the caller's fallback. It never returns its input for want of
 * anything better, because "show it anyway" is exactly how the braces got on
 * screen. A body shaped in a way nothing here understands is a body the owner
 * gains nothing from; the caller's fallback at least tells them what failed.
 */

/** Deep enough for `{error:{message}}`; anything deeper is a payload, not a message. */
const MAX_UNWRAP_DEPTH = 4;

/** The keys an error body carries a human sentence under, in order of preference. */
const MESSAGE_KEYS = ["error", "message", "detail", "description"] as const;

/** A string that is really a serialized body, not prose the owner should read. */
function looksLikeSerializedBody(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

/**
 * The sentence inside `value`, or `null` when there is not one.
 *
 * `null` rather than a fallback so the recursion can tell "nothing here" from
 * "a sentence that happens to be empty", and so only the entry point below
 * decides what an unreadable body turns into.
 */
function unwrap(value: unknown, depth: number): string | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // A JSON body that arrived as text: parse it and keep unwrapping. If it
    // does not parse, it is prose that merely starts with a brace, and prose
    // is what we were looking for.
    if (looksLikeSerializedBody(trimmed)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
      return unwrap(parsed, depth + 1);
    }
    return trimmed;
  }

  // An array body carries no single message; the first member that does wins.
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = unwrap(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      if (!(key in record)) continue;
      const found = unwrap(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Numbers, booleans, null, undefined: a status code is not a sentence.
  return null;
}

/**
 * A sentence for the owner, from whatever shape the API answered with.
 *
 * `value` may be a parsed body, a single field off one, or the raw response
 * text — every caller in the wizard has one of those three and none of them can
 * be trusted to be a string.
 */
export function humanizeApiError(value: unknown, fallback: string): string {
  return unwrap(value, 0) ?? fallback;
}
