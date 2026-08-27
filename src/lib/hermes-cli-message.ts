/**
 * How a `hermes` CLI failure is turned into text a customer may read.
 *
 * These live here, not in the chat route, because the chat bubble is not the
 * only place a person sees `hermes` stderr. The AI-provider panel in Settings
 * renders it twice more — `hermes auth add` (provider-key) and
 * `hermes config set` (models) — and both echoed the stream verbatim, so the
 * traceback frames and on-device paths PR #515 stripped out of chat reached
 * the screen anyway, one panel over. One parser, every surface.
 *
 * The grep that says the surfaces are all accounted for:
 *   grep -rn "stderr" src/app/setup-api/hermes --include=route.ts
 */
import { sanitizeErrorMessage } from "@/lib/safe-error-text";

/**
 * Turn a `hermes` subcommand's stderr into something worth showing a person.
 *
 * The evidence below was captured from `chat -q`, the subcommand that shaped
 * these rules. Nothing here is specific to it: each rule either fires on a
 * shape the other subcommands also produce (a traceback, a wrapped sentence) or
 * matches nothing in their output at all (the session banner), so applying it
 * to `auth add` and `config set` changes only the cases it was written for.
 *
 * The first thing on stderr is always the `session_id:` banner, so a failed run
 * used to surface as "Error: session_id: 20260810_221825_609d1e" — the one line
 * on the stream that says nothing about what went wrong. The actual cause sat
 * on the next line: "HTTP 404: Model 'claude-opus-5' not found. The requested
 * model does not exist in our configuration or OpenRouter catalog."
 *
 * So: drop the banner and anything else that is pure bookkeeping, and lead with
 * the first line that names a failure — a stack trace's later frames are worse
 * than useless in a chat bubble.
 */
export function errorFromStderr(stderr: string): string {
  return usefulLines(stderr)[0] ?? "";
}

/**
 * Hermes hard-wraps its output at ~76 columns, so ONE sentence arrives as
 * several lines. Rejoining them is the difference between
 *
 *   "No inference provider configured. Run 'hermes model' to choose a provider and"
 *
 * — which is what the customer used to get, ending on a dangling "and" — and the
 * whole message, whose second half is the part they can act on: which API key to
 * set, and that it goes in ~/.hermes/.env.
 *
 * A line continues the one above it when the one above looks WRAPPED: long
 * enough to have hit the wrap column, and followed by something that does not
 * start a new record of its own (a list item, a `key: value` line, an
 * `HTTP 404:` / `SomeError:` header). Nothing here joins two independent
 * failures — those start with one of those markers — and a short line is never
 * treated as wrapped, so a terse two-line report stays two lines.
 */
const WRAP_COLUMN_HINT = 60;

function startsNewRecord(line: string): boolean {
  return /^(?:[-*•]|\d+[.)])\s/.test(line)
    || /^HTTP\s+\d{3}\b/.test(line)
    || /^[A-Za-z][\w.]*(?:Error|Exception|Warning)\b/.test(line)
    || /^[A-Za-z][\w .\-]*:\s/.test(line);
}

function unwrap(lines: string[]): string[] {
  const paragraphs: string[] = [];
  for (const line of lines) {
    const previous = paragraphs[paragraphs.length - 1];
    if (previous !== undefined && previous.length >= WRAP_COLUMN_HINT && !startsNewRecord(line)) {
      paragraphs[paragraphs.length - 1] = `${previous} ${line}`;
    } else {
      paragraphs.push(line);
    }
  }
  return paragraphs;
}

/** The cap is per MESSAGE, not per line — a bubble is not a log viewer. */
const MAX_MESSAGE_CHARS = 400;

/**
 * Lines `chat -q` prints as STATUS, not as causes.
 *
 * `--resume` announces itself on stderr before the turn says anything, and on
 * EVERY resumed run — success or failure alike. Captured verbatim from the
 * live box (exit 1, the real cause sitting on stdout as "HTTP 403 — Just a
 * moment..."):
 *
 *   ↻ Resumed session 20260825_165225_be089e "What model are you and what is
 *   this machine?" (2 user messages, 7 total messages)
 *   Model restored from session: claude-fable-5 (anthropic)
 *   session_id: 20260825_165225_be089e
 *
 * Because only the `session_id:` line was being stripped, `errorFromStderr`
 * found the resume banner, decided stderr "said something", and the customer's
 * bubble read "Error: ↻ Resumed session …" while the actual failure was never
 * looked at. A banner is bookkeeping exactly like the session id under it.
 *
 * Matching on text is the only classifier available HERE: the CLI's streams
 * carry no framing to gate on. The streamed transport does not have this
 * problem to begin with — the dashboard socket reports the same resume as a
 * typed `session.resume` RESULT frame (captured live: `{"resumed":
 * "20260825_165225_be089e", …}`), never as an event the turn loop could
 * mistake for output.
 */
function isBookkeepingLine(line: string): boolean {
  return /^session_id:/i.test(line)
    || /^(?:↻\s*)?Resumed session\b/.test(line)
    || /^Model restored from session\b/.test(line)
    // The connectors CPython prints between chained tracebacks. They sit at
    // column 0, so they survive the frame strip below, and they name no cause.
    || /^(?:During handling of the above exception|The above exception was the direct cause)\b/
      .test(line);
}

/**
 * Drop the FRAMES of a Python traceback, keeping only its summary line.
 *
 * CPython indents everything belonging to a frame — the `File "…"` header, the
 * source line under it and (3.11+) the `^^^^` anchor beneath that — and returns
 * the exception summary to column 0. Trimming every line before classifying it
 * threw that signal away. Only the frame HEADER was being dropped, so the
 * source line under it survived, matched the "names a failure" filter below on
 * its `RuntimeError(` text, and — sitting earlier in the stream than the real
 * summary — became the customer's error bubble. Captured shape:
 *
 *   Traceback (most recent call last):
 *     File "/home/clawbox/.hermes/agent.py", line 88, in _call_provider
 *       raise RuntimeError("upstream refused the request")     <- what was shown
 *   RuntimeError: upstream refused the request                 <- what to show
 *
 * So classify on the RAW line: once a traceback opens, drop everything indented
 * under it and let the first column-0 line both end the block and stand as the
 * cause. A frame header opens a block too, so a stream whose `Traceback:` line
 * was already cut off still reads correctly. If the stream ENDS inside the
 * frames, nothing is invented — the caller falls back to the exit code rather
 * than quoting Python source at a customer. The block is scoped: once it ends,
 * an indented line is ordinary output again.
 *
 * A frame header is matched by its FULL shape — `File "…", line <n>` — not by
 * its first six characters. `File "config.yaml" was denied` is a sentence a
 * customer needs to read, and the loose form both swallowed it and reopened a
 * block that had already closed, taking the indented lines after it with it.
 */
const TRACEBACK_OPENER = /^[ \t]*(?:Traceback\b|File "[^"]+", line \d+\b)/;

function withoutTracebackFrames(lines: string[]): string[] {
  const kept: string[] = [];
  let inTraceback = false;
  for (const line of lines) {
    if (TRACEBACK_OPENER.test(line)) {
      inTraceback = true;
      continue;
    }
    if (inTraceback) {
      if (!line || /^[ \t]/.test(line)) continue;
      inTraceback = false;
    }
    kept.push(line);
  }
  return kept;
}

/**
 * An absolute on-device path, wherever it sits in a line we are keeping.
 *
 * Dropping the traceback FRAMES does not get the paths out, because the line
 * the strip deliberately KEEPS is the one that quotes them. Every common
 * CPython summary is that shape:
 *
 *   FileNotFoundError: [Errno 2] No such file or directory: '/home/clawbox/.hermes/config.yaml'
 *   PermissionError: [Errno 13] Permission denied: '/home/clawbox/.hermes/auth-profiles.json'
 *
 * It sits at column 0, it genuinely names the failure, and there is no
 * traceback at all in the plain `Error: cannot write /home/… ` case. So the
 * layout travelled with the cause, past every rule above.
 *
 * Redacting beats dropping here: `FileNotFoundError` and `Permission denied`
 * are what the person can act on, and only the path has to go. The journal
 * still receives the raw stream.
 *
 * Scoped to ABSOLUTE paths under the system roots, and NOT to a leading `~`.
 * `~/.hermes/.env` names no user, no home directory and no install layout — it
 * is the file Hermes itself tells the customer to edit, and keeping that half
 * of the sentence is part of what #515 fixed. A rule wide enough to catch the
 * tilde would replace the one actionable fact in that message with `<path>`.
 * Anchored on a preceding boundary so "2/3 of the files" is not a path.
 */
const SYSTEM_ROOT = "(?:home|root|usr|opt|var|etc|tmp|srv|mnt|snap)";

/**
 * A QUOTED absolute path, matched first and to its closing quote.
 *
 * POSIX components may contain spaces, and CPython quotes the path it failed
 * on, so the unquoted rule below — which stops at the first character no path
 * component is allowed to contain — left the tail of one on screen:
 *
 *   No such file or directory: '<path> Files/credentials.json'
 *
 * Still a directory and a filename. Inside quotes the closing quote is the real
 * end of the path, so that is what bounds this match; any other quote character
 * ends the class first and the match simply fails, falling through to the
 * unquoted rule rather than swallowing the rest of the line.
 */
const QUOTED_DEVICE_PATH = new RegExp(`(['"\`])\\/${SYSTEM_ROOT}\\/[^'"\`\\n]*\\1`, "g");

/** The same path unquoted, bounded by the first character a component cannot hold. */
const DEVICE_PATH = new RegExp(`(?<![\\w~])\\/${SYSTEM_ROOT}(?:\\/[\\w.@+-]+)+`, "g");

/** Both forms, quoted first so a space inside quotes cannot cut the match short. */
function redactDevicePaths(line: string): string {
  return line.replace(QUOTED_DEVICE_PATH, "<path>").replace(DEVICE_PATH, "<path>");
}

/** Bookkeeping and stack noise, dropped before we look for a cause. */
function usefulLines(stream: string): string[] {
  // Strip frames BEFORE trimming: the indentation is the only thing that tells
  // a frame's source line apart from a line the customer needs to read.
  const lines = withoutTracebackFrames(stream.split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l && !isBookkeepingLine(l));
  // Unwrap FIRST: the filter below keeps lines that themselves name a failure,
  // and the continuation lines of a wrapped message read as prose. That is how
  // the remedy half of every multi-line Hermes error was being dropped.
  const paragraphs = unwrap(lines);
  const named = paragraphs.filter((l) =>
    /\b(?:HTTP\s+\d{3}|error|failed|not found|denied|invalid|unauthor)/i.test(l));
  // Redact AFTER the filter, so a line is still classified on what it actually
  // said, and BEFORE the cap, so the truncation counts the text a person will
  // see rather than a path they never will.
  return (named.length ? named : paragraphs)
    .map(redactDevicePaths)
    .map((l) => l.length > MAX_MESSAGE_CHARS ? `${l.slice(0, MAX_MESSAGE_CHARS - 1)}…` : l);
}

/**
 * The message for a failed turn, from whichever stream actually carries it.
 *
 * Reading stderr alone was not enough. On a provider-side failure Hermes puts
 * the explanation on STDOUT — "API call failed after 3 retries: HTTP 404:
 * model: claude-opus-4-20250514" — and leaves stderr holding only the
 * `session_id:` banner. Stripping that banner (correctly) then left nothing,
 * so the customer got "hermes exited with code 1": true, and useless.
 *
 * stderr is still preferred when it says something, since a crash reports
 * there; stdout is the fallback that covers the provider-error case.
 */
export function hermesFailureMessage(stdout: string, stderr: string): string {
  return errorFromStderr(stderr) || (usefulLines(stdout)[0] ?? "");
}

/**
 * The same message, but only if it is safe to render to a customer.
 *
 * `hermesFailureMessage` answers "what did the CLI say went wrong". That is a
 * different question from "may this be shown to a person", and conflating them
 * is how the panel would keep leaking after the frames were stripped: a CLI
 * needs no traceback to name the install layout, and the ordinary one-line
 * EACCES shape —
 *
 *   Error: cannot write /home/clawbox/.hermes/config.yaml: permission denied
 *
 * — survives every rule above, because it genuinely IS the cause and it
 * genuinely does name a failure.
 *
 * So the last word belongs to `sanitizeErrorMessage`, the repo's existing
 * whitelist-by-shape ("one place that decides whether a message produced by a
 * failing layer may be shown"), which already drops paths, URLs, credentials,
 * stack frames and internal handles. Returning "" rather than the unsafe text
 * lets each caller fall back to the fixed sentence it already has.
 */
export function safeHermesFailureMessage(stdout: string, stderr: string): string {
  return sanitizeErrorMessage(hermesFailureMessage(stdout, stderr)) ?? "";
}

/**
 * What to say when the child could not be STARTED at all.
 *
 * Node formats every spawn failure identically, and the format contains the
 * install path:
 *
 *   spawn /home/clawbox/.local/bin/hermes ENOENT
 *   spawn /home/clawbox/.local/bin/hermes EACCES
 *   spawn /home/clawbox/.local/bin/hermes EAGAIN
 *
 * Both spawn sites recognised ENOENT and rewrote it PRECISELY so that path
 * would not reach a customer — then fell through to the raw error object for
 * every other errno, which reaches the same screens through the same field.
 * None of the cleaning above applies to these: a spawn failure never touches
 * stdout or stderr, so it never passes through `usefulLines`.
 *
 * The errnos are grouped by what the person can DO about them, which is the
 * only distinction worth putting in a bubble:
 *
 *   ENOENT          Hermes is not installed (or was removed mid-update).
 *   EACCES / EPERM  The binary is there and not executable — a partial update
 *                   that lost the mode bit, or a foreign owner.
 *   EAGAIN / ENOMEM fork(2) refused. On a loaded aarch64 box under memory
 *                   pressure this is the realistic one, and it is transient,
 *                   so the message says to retry.
 *
 * Anything else gets the neutral line rather than the errno text: an errno we
 * have not thought about is exactly the case where the raw string is most
 * likely to carry something we did not intend to publish.
 */
export function spawnFailureMessage(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
      return "Hermes is not installed on this device";
    case "EACCES":
    case "EPERM":
      return "Hermes could not be started on this device (permission denied)";
    case "EAGAIN":
    case "ENOMEM":
      return "The device was out of resources to start Hermes — try again in a moment";
    default:
      return "Hermes could not be started on this device";
  }
}
