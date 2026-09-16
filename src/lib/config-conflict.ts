// ── The one config-write failure that is safe to retry ──────────────────────
//
// OpenClaw's config writer uses optimistic concurrency: it loads the file,
// remembers its content hash, and refuses the write if the hash moved before
// the rename. On a box doing several things at once the refusal is ordinary —
// it is not a broken config, it is two writers overlapping, and the loser's
// mutation converges on the next attempt against the fresh file.
//
// The refusal has TWO spellings on the wire, and this module exists because
// ClawBox only ever knew the first one:
//
//   ConfigMutationConflictError: config changed since last load
//
//   The config file changed while this command was writing (config changed
//   since last load), so nothing was changed. Re-run the same command to pick
//   up the new file and try again.
//
// The second is what the CLI prints when it words a failure for a human, and it
// carries no class name at all. A retry keyed on the class name alone does not
// fire for it: the write is reported as a hard failure, the raw sentence
// travels up as the error message, and the chat panel rendered it as the first
// thing the owner saw after finishing setup — an instruction to re-run a
// command they have never typed, about a file they do not know exists.
//
// So the signature is matched on the WORDING as well as the class, in the same
// spirit as `isSessionTakeover` in chat-error-text.ts: the CLI's own words are
// the contract we actually receive, and pinning only its internals is what let
// a re-worded error through.
//
// Deliberately free of `node:` imports and of "server-only": both halves of the
// fix need this predicate — the server to know a write may be retried, the chat
// panel to know a failure is a passing collision rather than something to
// report in OpenClaw's words — and two spellings of one signature is precisely
// how this bug got in.

/**
 * Machine-readable `code` for "the config was busy, nothing was written".
 *
 * An API answers this INSTEAD of the CLI's sentence: the client needs to know
 * which failure it has without reading prose that is written for a terminal,
 * changes between OpenClaw releases, and exists in one language only.
 */
export const CONFIG_BUSY_ERROR_CODE = "config_busy";

/**
 * The English fallback that rides with {@link CONFIG_BUSY_ERROR_CODE}.
 *
 * Every ClawBox surface renders the translated copy off the code, so this is
 * for the non-UI readers of an API response — a log line, `curl`, an older
 * client that predates the code. It says what happened and what to do, and it
 * names neither the config file nor a command to re-run.
 */
export const CONFIG_BUSY_MESSAGE =
  "The box was saving its settings at the same moment, so nothing was changed. Try again in a moment.";

/**
 * Is this failure OpenClaw's optimistic-concurrency refusal?
 *
 * Accepts an `Error`, a bare string, or anything else (answering false), so a
 * caller does not have to narrow before asking. Both known spellings match; the
 * shared half of the two — "config changed since last load" — is what the class
 * name and the humanized sentence agree on, and the third test is there because
 * the humanized wording could keep only its own opening clause.
 *
 * Narrow on purpose. "config changed" alone would match a perfectly ordinary
 * success line, and a predicate that retries an error the CLI means to be final
 * turns one clear refusal into four slow ones.
 */
export function isConfigMutationConflict(raw: unknown): boolean {
  const text = raw instanceof Error
    ? raw.message
    : typeof raw === "string"
      ? raw
      : "";
  if (!text) return false;
  return /ConfigMutationConflictError/i.test(text)
    || /config changed since last load/i.test(text)
    || /config file changed while this command was writing/i.test(text);
}

/**
 * Does this JSON body say "the config was busy"?
 *
 * The `code` is the contract, and it is what a current ClawBox server sends.
 * The `error` text is still examined because the client must survive the case
 * this bug is about: a response from something that has NOT been taught the
 * code — a server mid-upgrade, a proxy relaying an older body — must not put
 * the CLI's sentence on screen just because the field it arrived in changed.
 */
export function isConfigBusyPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as { code?: unknown; error?: unknown };
  return body.code === CONFIG_BUSY_ERROR_CODE || isConfigMutationConflict(body.error);
}
