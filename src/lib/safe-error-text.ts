// -- Customer-safe error text ----------------------------------------------
//
// One place that decides whether a message produced by a failing layer may be
// shown to the person using the box.
//
// Errors are the classic way internals escape onto a customer's screen: a
// route quotes the request it could not serve, and the request carried a
// bearer token; an fs error quotes the path it could not write, and the path
// names the customer's home directory and our media layout. So this is a
// whitelist by SHAPE rather than a blocklist of known-bad strings — anything
// that looks like a path, a URL, a credential or a stack frame is dropped
// whole, and the caller falls back to its own generic line.
//
// Extracted from `describeTranscribeFailure` (TASK-381) when the chat
// attachment path needed the same rules: two copies of a leak filter is two
// places to forget a rule.

/**
 * Return `raw` if it is safe to render to a customer, otherwise null.
 *
 * Null means "say something generic", never "say nothing" — a caller that
 * shows no message at all is the silent-failure bug this exists to prevent.
 */
export function sanitizeErrorMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A POSIX-looking path segment: `/home/clawbox/…`, `…/.openclaw/media/…`.
  if (/(^|\s)\/[\w.-]+\//.test(trimmed)) return null;
  if (/https?:\/\//i.test(trimmed)) return null;
  if (/\b(claw_|sk-|Bearer\s)/i.test(trimmed)) return null;
  // `at fn (` — a V8 stack frame.
  if (/\bat\s+\w+\s+\(/.test(trimmed)) return null;
  return trimmed;
}

/** Pull `.error` off a JSON error body and sanitize it in one step. */
export function sanitizeErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  return sanitizeErrorMessage((payload as { error?: unknown }).error);
}
