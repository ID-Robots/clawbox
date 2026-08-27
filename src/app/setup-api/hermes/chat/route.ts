export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { StringDecoder } from "string_decoder";
import { HERMES_BIN } from "@/lib/harness";
import {
  HERMES_AUTO_PROVIDER,
  isHermesCliProvider,
  isPlausibleHermesProviderId,
  isSafeHermesModelId,
} from "@/lib/hermes-providers";
import {
  clampReasoningForProvider,
  hermesReasoningLevelsFor,
  normalizeReasoningForWire,
  HERMES_LOCAL_REASONING_PROVIDER,
  providerHasBinaryReasoning,
  providerHasReasoningControl,
  isHermesReasoningLevel,
  isReasoningLevelAllowedFor,
  type HermesLocalBackend,
} from "@/lib/hermes-reasoning";
import { getConfiguredLocalAiBackend } from "@/lib/local-ai-backend";
import {
  isSmallLocalModel,
  slimLocalProfileEnabled,
  smallLocalModelToolsets,
} from "@/lib/local-model-profile";
import {
  getModelOptions,
  isAllowedProvider,
  isPairAllowed,
  shouldEnforcePairing,
  type ModelOptionsPayload,
} from "@/lib/hermes-model-options";
import { appendTranscript } from "@/lib/harness/transcript-store";
import { resolveInMediaRoot } from "@/lib/harness/media-root";
import { mediaUrl, splitAssistantMedia } from "@/lib/chat-media";
import { extractReasoningPanels, stripAgentStatusFrames } from "@/lib/hermes-reasoning-panel";
import { readHermesTurn } from "@/lib/harness/hermes-turn-record";
import {
  adoptHermesGeneratedImages,
  reclaimImageMentions,
  servableMediaRoot,
} from "@/lib/harness/hermes-generated-media";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";
import { isQuietStreamError, openDashboardTurn, type DashboardTurn } from "@/lib/hermes-dashboard-turn";

/**
 * How many images one turn may carry — the same number the composer is told,
 * read from the capability table rather than written down twice. Only the FIRST
 * rides `--image`; the rest are resolved out of the prompt text, which is why
 * the Hermes number is the lower of the two.
 */
const MAX_IMAGES_PER_TURN = capabilitiesFor("hermes", UNKNOWN_FACTS).maxAttachmentsPerTurn;

// Chat turn against the Hermes harness, via `hermes chat -q <message> -Q`
// (single query, non-interactive). The message is passed as an argv element
// (no shell), so user input can't inject a command.
//
// It used to use `-z` (one-shot) on the belief that one-shot reused a
// persistent session. That was WRONG and the chat had no memory at all: `-z`
// starts a new session per invocation, ignores --resume, and documents itself
// as printing "no session_id line". `chat -q` threads properly — it echoes
// `session_id: <id>`, and passing that back via --resume continues the same
// conversation.
//
// This is the desktop chat backend when the active harness is Hermes; OpenClaw
// keeps its gateway WebSocket. Streaming is still a future upgrade (the Hermes
// serve WS supports it).

const HOME_DIR = process.env.HOME || "/home/clawbox";
// An agentic turn is not a completion: the agent may run a dozen tools, launch
// a browser, wait on a page. 90s killed exactly those — "open facebook on the
// browser" died mid-run, and a plain file-checking turn had already taken 42s
// across 6 tool calls on this hardware. The client can still abort at any time
// (Stop), and the model itself has iteration limits, so this ceiling exists
// only to stop a truly wedged process living forever.
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_CHAT_TIMEOUT_MS || 600_000);
// A chat reply can't legitimately exceed this; cap the buffer so a runaway
// process can't grow it unbounded.
const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * `chat -q` writes the REPLY to stdout and its `session_id: <id>` banner to
 * STDERR, so both streams are returned: stdout is the answer verbatim (nothing
 * to strip), stderr is where the conversation id comes from.
 */
function runHermes(args: string[], signal?: AbortSignal): Promise<{ out: string; err: string }> {
  return new Promise<{ out: string; err: string }>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    let settled = false;
    const child = spawn(HERMES_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: HOME_DIR,
      env: {
        ...process.env,
        HOME: HOME_DIR,
        PATH: `${path.dirname(HERMES_BIN)}:${process.env.PATH || ""}`,
      },
    });
    let out = "";
    let err = "";
    let outBytes = 0;
    let errBytes = 0;
    // Decode ACROSS chunk boundaries. `chunk.toString()` per chunk turns any
    // multi-byte sequence straddling a pipe boundary into U+FFFD — and this
    // product ships a Bulgarian UI, so Cyrillic (and emoji) replies are the
    // normal case, not an edge case. Byte caps still count raw `chunk.length`.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    // The user hit Stop (or the request was aborted) — kill the process so the
    // model doesn't keep running for a reply nobody will read.
    const onAbort = () => {
      if (settled) return;
      cleanup();
      child.kill("SIGKILL");
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        cleanup();
        child.kill("SIGKILL");
        reject(new Error("Hermes output exceeded the size limit"));
        return;
      }
      out += outDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      errBytes += chunk.length;
      // A failing hermes can spew unbounded stderr. Once it clears the cap the
      // run is already a loss — kill the child (don't let it keep burning CPU
      // until the timeout) and reject with what we captured. Mirrors stdout.
      if (errBytes > MAX_OUTPUT_BYTES) {
        cleanup();
        child.kill("SIGKILL");
        reject(new Error(errorFromStderr(err) || "Hermes error output exceeded the size limit"));
        return;
      }
      err += errDecoder.write(chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      child.kill("SIGKILL");
      reject(new Error("Hermes timed out"));
    }, HERMES_TIMEOUT_MS);

    child.on("error", (e) => {
      if (settled) return;
      cleanup();
      // A missing binary surfaces as ENOENT with the full spawn path in the
      // message (`spawn /home/clawbox/.local/bin/hermes ENOENT`). Don't leak
      // that path to the client — report the actionable cause instead.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Hermes is not installed on this device"));
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      cleanup();
      // Flush whatever partial sequence the decoders are still holding.
      out += outDecoder.end();
      err += errDecoder.end();
      if (code === 0) resolve({ out: out.trim(), err });
      else reject(new Error(hermesExitMessage(code, out, err)));
    });
  });
}

/**
 * Turn `chat -q`'s stderr into something worth showing a person.
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
function errorFromStderr(stderr: string): string {
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
 */
const TRACEBACK_OPENER = /^[ \t]*(?:Traceback\b|File ")/;

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
  return (named.length ? named : paragraphs).map((l) =>
    l.length > MAX_MESSAGE_CHARS ? `${l.slice(0, MAX_MESSAGE_CHARS - 1)}…` : l);
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
function hermesFailureMessage(stdout: string, stderr: string): string {
  return errorFromStderr(stderr) || (usefulLines(stdout)[0] ?? "");
}

/**
 * The exit code `hermes chat -q` uses when a turn is cut short by a signal.
 *
 * It looks like the shell's 128+SIGINT convention, and that reading is wrong in
 * a way that matters. Hermes installs ONE handler for SIGINT, SIGTERM and
 * SIGHUP whose last act is to raise KeyboardInterrupt; the `-q` path catches
 * that around the turn and calls `sys.exit(130)` explicitly. So:
 *
 *   - the code is numeric rather than null (a signal-KILLED child reports
 *     `code === null`), which is why this arrives here at all rather than
 *     through the abort path; and
 *   - 130 does NOT identify which signal arrived. All three produce it, and the
 *     child leaves nothing behind to tell them apart.
 *
 * Verified on-device by injecting each signal into a live turn: every one gave
 * exit 130, an EMPTY stdout, and a stderr holding only the `session_id:`
 * banner. That is precisely the input `hermesFailureMessage` cannot work with —
 * the banner is stripped as bookkeeping, nothing else is there, and the turn
 * used to surface as the bare "hermes exited with code 130".
 */
const HERMES_INTERRUPTED_EXIT_CODE = 130;

/**
 * What to tell a customer whose turn was cut short.
 *
 * Deliberately says "interrupted", never "cancelled" or "you stopped it": the
 * signal's identity is unrecoverable (see above), so naming a cause we cannot
 * know would be a guess dressed as a diagnosis. A user-initiated Stop does not
 * reach this path at all — that aborts the request, kills the child with
 * SIGKILL, and returns 499.
 *
 * The most common cause on a real device is the web server restarting (an
 * update, or a service restart) while the model was still answering: the
 * harness is a child of that server, so it goes down with it. Hence the
 * reassurance — the message itself is safe, and re-sending is the fix.
 */
function interruptedTurnMessage(): string {
  return "The assistant was interrupted before it could answer — this usually means "
    + "the device restarted a service while the model was still working. "
    + "Your message was not lost: send it again.";
}

/**
 * The error text for a non-zero exit, preferring whatever the process actually
 * said and falling back to a named cause instead of a raw exit code.
 */
function hermesExitMessage(code: number | null, stdout: string, stderr: string): string {
  // Named in the journal so a failed resumed turn can be checked from the
  // outside: the banner WAS received, and it was classified as bookkeeping.
  if (/^(?:↻\s*)?Resumed session\b/m.test(stderr)) {
    console.log("[hermes] resume banner on stderr ignored as bookkeeping, not an error");
  }
  const reported = hermesFailureMessage(stdout, stderr);
  if (reported) return reported;
  if (code === HERMES_INTERRUPTED_EXIT_CODE) return interruptedTurnMessage();
  return `hermes exited with code ${code}`;
}

/** Exported for tests only — these are pure string helpers, and the failure
 *  they guard was only visible in the exact stdout/stderr split below. */
export const __test = {
  hermesFailureMessage,
  errorFromStderr,
  hermesExitMessage,
  HERMES_INTERRUPTED_EXIT_CODE,
};

// Hermes session ids are timestamped slugs: 20260810_194609_7568b9. Strict on
// purpose — this value reaches argv, and anything looser could smuggle a flag.
const SESSION_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;

/**
 * Pull the conversation id out of `chat -q`'s stderr banner (`session_id: …`).
 * (`-z` documents itself as printing "no session_id line" — which is exactly
 * why one-shot mode cannot thread a conversation.)
 */
function parseSessionId(stderr: string): string {
  const match = /^\s*session_id:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]{6})\s*$/m.exec(stderr);
  return match ? match[1] : "";
}

/** The reply this route hands back, whichever transport produced it. */
interface TurnPayload {
  text: string;
  harness: "hermes";
  reasoning?: string;
  toolCalls?: readonly unknown[];
  sessionId?: string;
  /**
   * The model that actually served this turn, and its provider.
   *
   * Recorded because the alternative was proven to hide a real defect: with the
   * pills showing one model and the session running another, nothing in the
   * reply said which had answered, and the mismatch was only found by asking
   * the model directly. Stored per turn, so a conversation that changed models
   * halfway keeps an accurate account of which reply came from where.
   */
  model?: string;
  provider?: string;
}

/** Did the caller ask to be streamed to, rather than handed a finished turn? */
function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") || "").includes("text/event-stream");
}

/**
 * Turn a finished run into the answer, and record it.
 *
 * ── Answer, thinking and tool steps, pulled apart ─────────────────────────
 *
 * TWO SOURCES, IN THIS ORDER, and the order is the whole point.
 *
 * What `chat -q … -Q` prints is a console rendering, and on this hardware it is
 * a lossy one. Captured from the live box with deepseek-v4-flash, a bare "Hey"
 * arrives as an OPENED reasoning frame that is never closed, the monologue
 * printed TWICE by two different producers, then the answer — and no tool
 * activity at all, because quiet mode prints none. Nothing in that stream marks
 * where thinking stops and the reply starts, so the parser below can only ever
 * handle the closed, framed case.
 *
 * The agent already has it right. `~/.hermes/state.db` stores the same turn as
 * `content`, `reasoning_content` and `tool_calls` in separate columns,
 * deduplicated, which is exactly the split the UI wants. So we ask the agent's
 * own record first, keyed by the session id the run reported, and keep the
 * console parse as the floor under it.
 *
 * The streaming transport lands here too, and needs the same treatment for a
 * different reason: its text is already clean (the answer and the monologue
 * arrive on separate channels), but only the database has the TOOL STEPS, which
 * no amount of reading the reply can recover.
 */
async function settleTurn(
  threaded: string,
  consoleText: string,
  streamedReasoning: string,
  served: { model?: string; provider?: string } = {},
): Promise<TurnPayload> {
  const consoleReply = extractReasoningPanels(consoleText);
  const record = await readHermesTurn(threaded);
  const spoken = record?.text ?? consoleReply.text;
  // The model's own copy of the path comes OUT of the caption and INTO the
  // adoption list, because `splitAssistantMedia` below lifts EVERY surviving
  // MEDIA: line into a card without asking where it points. Left in, a path the
  // model merely repeated became a second, unservable attachment beside the
  // real one (#482), and a path the agent wrote itself became the only
  // attachment and a dead one. Only what adoption actually copied is said
  // again, so a card exists exactly when there is a picture behind it.
  //
  // The media root is handed in as the ONE exemption: paths the browser can
  // already fetch stay in the caption for `splitAssistantMedia` to lift, which
  // is how a picture the customer attached and the model echoed back keeps
  // working. Everything else has to earn its card through adoption.
  const servableRoot = await servableMediaRoot();
  const { text: caption, sources: mentioned } = reclaimImageMentions(spoken, servableRoot);
  const drawn = await adoptHermesGeneratedImages(
    [...(record?.generatedImages ?? []), ...mentioned],
    // The SAME root the caption was judged against, so the two halves cannot
    // disagree about which tree is already servable.
    servableRoot,
  );
  // A picture the AGENT drew, said the way every other picture in this chat is
  // said. Hermes has no `MEDIA:` convention of its own — the backend saves the
  // file and the model writes prose about the path — so the reply reaches the
  // browser as a sentence naming a file it cannot open. Appending the directive
  // here means the transcript, the adapter and the bubble all keep working
  // exactly as they do for a generated OpenClaw picture: `splitAssistantMedia`
  // a few lines down lifts these back out, and nothing downstream learns a new
  // shape.
  //
  // Appended AFTER the answer rather than replacing it: the model's own
  // sentence is the caption, and dropping it would leave a picture with no
  // words in a conversation the customer is having.
  const answer = [caption, ...drawn.map((file) => `MEDIA:${file}`)]
    .filter(Boolean)
    .join("\n");
  // The database first, the console parse next, and what the stream itself
  // carried as the floor — the last only matters when the turn ran but its row
  // could not be read back, which is the one case the other two are both empty.
  // The agent's spinner text is not reasoning — see `stripAgentStatusFrames`.
  // Applied to whichever source won, because each can carry it for a different
  // reason (an older record already stored one; the CLI can print one to
  // stdout), and a turn left with nothing but status frames must end with NO
  // reasoning at all: an empty disclosure reads worse than an absent one.
  const settledReasoning = stripAgentStatusFrames(
    record?.reasoning || consoleReply.reasoning || streamedReasoning,
  );
  const toolCalls = record?.toolCalls;
  // The ANSWER, and only on success. Media is split here rather than stored raw
  // so that the record holds exactly what the bubble renders, and a refreshed
  // transcript is byte-identical to the live one instead of showing a MEDIA:
  // directive as text.
  const reply = splitAssistantMedia(answer);
  await appendTranscript({
    role: "assistant",
    text: reply.text,
    timestamp: Date.now(),
    ...(reply.images.length ? { media: reply.images } : {}),
    ...(reply.audio.length ? { audio: reply.audio } : {}),
    // Persisted beside the answer, never inside it: replay has to be able to
    // collapse the monologue the same way the live turn did.
    ...(settledReasoning ? { reasoning: settledReasoning } : {}),
    ...(toolCalls?.length ? { toolCalls } : {}),
    // Which model actually answered. `state.db`'s `messages` table has no model
    // column, so the agent's turn record cannot supply this; the dashboard's
    // own `info` for the session — read at the moment the turn was submitted,
    // after any switch had been applied and acknowledged — is the authoritative
    // answer available, and it is the one the transport hands back.
    ...(served.model ? { model: served.model } : {}),
    ...(served.provider ? { provider: served.provider } : {}),
  });
  return {
    text: answer,
    harness: "hermes",
    ...(settledReasoning ? { reasoning: settledReasoning } : {}),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(threaded ? { sessionId: threaded } : {}),
    ...(served.model ? { model: served.model } : {}),
    ...(served.provider ? { provider: served.provider } : {}),
  };
}

/**
 * Stream a dashboard turn to the caller as it is written.
 *
 * Server-sent events, one named event per kind, because the two are genuinely
 * different things and the client must not have to guess which it is holding:
 *
 *   `delta` — a FRAGMENT of the answer, to append. Only ever the answer: the
 *             model's monologue arrives on its own channel upstream and this
 *             route does not forward it, so the raw thinking cannot flash into
 *             the bubble mid-stream. That is a property of the transport, not a
 *             filter that has to stay correct.
 *   `tool`  — a step the agent is taking RIGHT NOW, `phase` moving start →
 *             result. Not the record: the authoritative tool list still comes
 *             from the agent's database on `done`, and this is the live view
 *             that keeps a tool-heavy turn from looking like a hang. A turn can
 *             spend minutes inside one call emitting no text at all — measured
 *             at 240 seconds on the box — and before this the customer's only
 *             evidence that anything was happening was that nothing was.
 *   `status`— the agent's spinner line. A heartbeat, never the monologue.
 *   `clarify` — the agent has STOPPED and is asking the customer something,
 *             carrying the `requestId` its answer must be addressed to and one
 *             or more questions. Its own event and not a `status`, because it
 *             is the one frame in this stream the customer can act on: a
 *             surface has to draw a form, and the answer goes back over
 *             `/setup-api/hermes/chat/clarify` rather than up this stream,
 *             which is one-directional by design. Before this existed the
 *             frame was dropped on the floor and the agent sat parked on the
 *             question for its full hour-long timeout while the customer was
 *             told the stream had gone quiet.
 *   `clarifyExpire` — that question's window closed. Sent so the form comes
 *             down instead of leaving somebody typing an answer that can no
 *             longer be delivered.
 *   `done`  — the settled turn, byte-identical in shape to what the non-
 *             streaming path returns, including the tool steps and the
 *             deduplicated reasoning that only the agent's database has.
 *   `error` — the turn failed; the message is already customer-readable.
 *
 * Once the first byte is out the status code is spent, so a failure after that
 * point is reported inside the stream rather than as an HTTP error. Everything
 * that could have produced a clean 4xx/5xx has already run before this is called.
 */
function streamTurn(turn: DashboardTurn, fallbackSessionId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const threaded = turn.sessionId || fallbackSessionId;
      try {
        const final = await turn.run(
          (chunk) => send("delta", { text: chunk }),
          // Exhaustive on `kind`, deliberately, rather than "tool or else".
          // The `else` branch was an assumption that every non-tool activity is
          // a status line, and the day a third kind arrived it emitted one as
          // `status` with `text: undefined` — a question the customer needed to
          // answer, rendered as a blank spinner caption. A switch with a case
          // per kind makes the next addition a compile error instead.
          (activity) => {
            switch (activity.kind) {
              case "tool":
                send("tool", activity);
                break;
              case "status":
                send("status", { text: activity.text });
                break;
              case "clarify":
                send("clarify", {
                  requestId: activity.requestId,
                  questions: activity.questions,
                  // Only on a replayed batch, and only when something really is
                  // already answered — an empty map would read as "nothing
                  // filled in", which is what it means, so it is not sent.
                  ...(activity.answered ? { answered: activity.answered } : {}),
                });
                break;
              case "clarifyExpire":
                send("clarifyExpire", { requestId: activity.requestId });
                break;
              default: {
                // The line that makes the promise above TRUE rather than
                // aspirational. A switch with no `default` over a callback
                // returning `void` compiles perfectly happily when a fifth
                // DashboardActivity member appears — it just drops it on the
                // floor at runtime, which is the exact failure this switch
                // replaced. Assigning the narrowed value to `never` turns that
                // into a build error naming the kind nobody handled.
                const unhandled: never = activity;
                void unhandled;
                break;
              }
            }
          },
        );
        if (final.status === "error") {
          const detail = final.error || final.text || "Hermes chat failed";
          await appendTranscript({
            role: "system",
            text: `Error: ${detail}`,
            timestamp: Date.now(),
            variant: "error",
          });
          send("error", { error: detail });
        } else {
          send(
            "done",
            await settleTurn(threaded, final.text, final.reasoning, {
              // What the transport says answered, preferring the turn's own
              // report over the session's setting when it offers one.
              ...(final.model || turn.model ? { model: final.model || turn.model } : {}),
              ...(final.provider || turn.provider ? { provider: final.provider || turn.provider } : {}),
            }),
          );
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Hermes chat failed";
        // ── Silence is not failure: ask the agent before saying so ─────────
        //
        // A quiet stream means this socket stopped hearing. It does NOT mean
        // the turn did not happen, and on the live box the difference was the
        // whole bug. From the customer's own transcript: they asked a question
        // at 20:10:44, the agent ran two tools and wrote its 582-character
        // answer to `state.db` at 20:11:12, and its `message.complete` never
        // reached us. This route waited out the idle window and wrote "Error:
        // dashboard stream went quiet" into their transcript at 20:14:13 — a
        // finished answer thrown away and replaced with a failure, three
        // minutes after it was ready.
        //
        // So before reporting silence, read the record. `readHermesTurn` is
        // the same source `settleTurn` already trusts for every turn's
        // reasoning and tool steps, and it is self-guarding here: it slices
        // from the LAST user row, which is this turn's question, and returns
        // null unless an assistant answer follows it. A turn that really is
        // still thinking has no such row and still reports the failure.
        if (isQuietStreamError(err) && !isAbort(err)) {
          const recovered = await readHermesTurn(threaded).catch(() => null);
          if (recovered?.text) {
            send(
              "done",
              await settleTurn(threaded, recovered.text, "", {
                ...(turn.model ? { model: turn.model } : {}),
                ...(turn.provider ? { provider: turn.provider } : {}),
              }),
            );
            return;
          }
        }
        // A failure is recorded too — see the non-streaming path's note. The one
        // exception is a caller who hung up: the socket dies as a consequence of
        // their own Stop, and their unanswered question is already recorded.
        if (!isAbort(err)) {
          await appendTranscript({
            role: "system",
            text: `Error: ${detail}`,
            timestamp: Date.now(),
            variant: "error",
          });
          send("error", { error: detail });
        }
      } finally {
        turn.close();
        try {
          controller.close();
        } catch {
          /* the caller already went away */
        }
      }
    },
    cancel() {
      turn.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer a proxied response by default, which would
      // hold every fragment until the turn ended and undo the whole point.
      "x-accel-buffering": "no",
    },
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export async function POST(request: Request) {
  let body: {
    message?: string;
    /**
     * What the USER's bubble shows, when that differs from what the agent is
     * sent. Today the one case is the mid-conversation model-switch note the
     * adapter prefixes onto the prompt: the agent has to read it, and the
     * transcript must not replay it as something the customer typed.
     *
     * Only ever narrows what is recorded — the turn itself always runs on
     * `message`.
     */
    displayText?: string;
    /** Absolute paths of staged images to attach to this turn. */
    imagePaths?: unknown;
    model?: string;
    provider?: string;
    reasoning?: string;
    sessionId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  const rawProvider = typeof body.provider === "string" ? body.provider.trim() : "";
  let rawReasoning = typeof body.reasoning === "string" ? body.reasoning.trim() : "";
  const rawSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (rawSessionId && !SESSION_ID_RE.test(rawSessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  // Every value below reaches argv. No shell is involved (spawn takes an array)
  // but a value starting with "-" would still be parsed by hermes as a flag, so
  // each one is either a membership test against a literal set or a strict
  // charset check that cannot match a leading "-". These come from fixed
  // dropdowns, so an unrecognised value is a bug or an attack — reject it
  // rather than silently running the turn with different settings.
  if (rawModel && !isSafeHermesModelId(rawModel)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (rawReasoning && !isHermesReasoningLevel(rawReasoning)) {
    return NextResponse.json({ error: "Invalid reasoning level" }, { status: 400 });
  }
  // Fold a level the wire collapses onto the one it collapses to, BEFORE any
  // provider check runs. Today that is `ultra` → `max`: Hermes' own
  // clamp_effort does it for every OpenAI-compatible provider, so the two are
  // the same turn — but clawai answers the word `ultra` with HTTP 400, which
  // turned "a level with no effect" into "a level that fails". A client holding
  // a saved `ultra` from before it left the picker must not hit that.
  if (rawReasoning && isHermesReasoningLevel(rawReasoning)) {
    rawReasoning = normalizeReasoningForWire(rawReasoning);
  }
  // "auto" is ClawBox's pseudo-provider for "let Hermes decide", not a slug the
  // CLI knows — it maps to omitting the flag entirely, which is exactly what
  // hermes does without an override.
  const wantsProvider = Boolean(rawProvider) && rawProvider !== HERMES_AUTO_PROVIDER;
  if (wantsProvider && !isPlausibleHermesProviderId(rawProvider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  // The catalogue is process-cached (60 s fresh / 6 h stale-serve) and the chat
  // header warms it on mount, so in steady state this costs nothing. It is only
  // consulted for the checks a static list cannot make; when it is unavailable
  // we fall back to the static allowlist and let hermes itself judge the
  // pairing — a chat turn must not become impossible because the dashboard
  // blinked.
  // The built-in toolsets this turn is narrowed to, or null for "all of them".
  // Set only for a small on-device model — see the slim-profile block below.
  let slimToolsets: readonly string[] | null = null;

  let payload: ModelOptionsPayload | null = null;
  if (wantsProvider || rawModel) {
    try {
      payload = await getModelOptions();
    } catch {
      payload = null;
    }
  }

  // Canonical slug OR a user-defined provider the live dashboard reports.
  if (wantsProvider) {
    const known = payload ? isAllowedProvider(payload, rawProvider) : isHermesCliProvider(rawProvider);
    if (!known) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }
  }

  if (payload) {
    // The provider this turn will ACTUALLY run on: the override when one is
    // given, otherwise config.yaml's model.provider — because that is exactly
    // what hermes falls back to. `current` comes from `hermes config get`, so
    // it is accurate even when the model lists themselves are stale.
    const effectiveProvider = wantsProvider ? rawProvider : payload.current.provider;
    // Which runtime hosts the on-device model, when that is what this turn runs
    // on. It decides WHICH pair the two-state switch has: llama.cpp's off is
    // `minimal`, Ollama's is `none`, and Ollama answers `minimal` with HTTP 400
    // "does not support thinking" on a model without the capability — so
    // clamping to the wrong pair is a guaranteed failed turn. Only read for the
    // provider that needs it; every other turn skips the config-store hit.
    const localBackend: HermesLocalBackend | null = providerHasBinaryReasoning(effectiveProvider)
      ? await getConfiguredLocalAiBackend()
      : null;

    // The CLI accepting a level does not mean the PROVIDER does — Hermes passes
    // it through as `reasoning_effort` and the upstream API can reject it.
    // Verified: ClawBox AI answers `ultra` with HTTP 400 "reasoning_effort:
    // unknown". Refuse here with something actionable rather than spending the
    // turn to have the proxy refuse it.
    //
    // A provider with NO dial at all is a different case and must not 400: a
    // backend that never reads the field makes the level meaningless rather
    // than wrong. Failing the turn over a parameter that could not have changed
    // anything would be gratuitous — drop it and answer.
    //
    // A TWO-STATE provider (the on-device model: thinking on or off, nothing in
    // between) is a third case. Its two levels stand for the ends of a switch,
    // so a level from the middle of the scale is still answerable — the proxy
    // maps every level onto the boolean. A client holding a stale preference
    // must not get a failed turn for it; clamp to the nearest end instead.
    if (rawReasoning && !providerHasReasoningControl(effectiveProvider)) {
      rawReasoning = "";
    } else if (
      rawReasoning
      && isHermesReasoningLevel(rawReasoning)
      && providerHasBinaryReasoning(effectiveProvider)
    ) {
      rawReasoning = clampReasoningForProvider(effectiveProvider, rawReasoning, localBackend);
    } else if (
      rawReasoning
      && isHermesReasoningLevel(rawReasoning)
      && !isReasoningLevelAllowedFor(effectiveProvider, rawReasoning, localBackend)
    ) {
      return NextResponse.json(
        {
          error: `Provider "${effectiveProvider}" does not support the "${rawReasoning}" reasoning effort.`,
          allowed: hermesReasoningLevelsFor(effectiveProvider, localBackend),
        },
        { status: 400 },
      );
    }

    // The slim profile. On the on-device provider the fixed per-turn payload —
    // ~30 KB of system text plus 61 tool schemas, ~113 KB in total, measured
    // with `hermes prompt-size` and a live tools/list — is most of a small
    // model's budget, and it answers with tool preamble instead of the answer.
    // `-t` is a whitelist over the BUILT-IN toolsets only (verified against
    // agent_init.py / model_tools.py); MCP tools are merged separately, so the
    // ClawBox device tools survive it. See src/lib/local-model-profile.ts.
    if (
      effectiveProvider === HERMES_LOCAL_REASONING_PROVIDER
      && slimLocalProfileEnabled()
      && isSmallLocalModel({ modelId: rawModel || payload.current.model })
    ) {
      slimToolsets = smallLocalModelToolsets();
    }

    // Same pairing gate the config POST enforces: a provider must never run a
    // foreign vendor's model id. shouldEnforcePairing decides when we actually
    // know enough to judge — it skips a stale payload (a fallback manifest, not
    // the provider's truth) and a CREDENTIALED provider we couldn't enumerate,
    // but still enforces on an UNAUTHENTICATED one (which serves nothing, so
    // any model paired with it is wrong).
    if (
      rawModel
      && effectiveProvider
      && shouldEnforcePairing(payload, effectiveProvider)
      && !isPairAllowed(payload, effectiveProvider, rawModel)
    ) {
      return NextResponse.json(
        { error: `Model "${rawModel}" is not available from provider "${effectiveProvider}"` },
        { status: 400 },
      );
    }

    // --provider WITHOUT -m makes hermes fall back to config.yaml's
    // model.default, which belongs to the CONFIGURED provider. Overriding one
    // half of the pair would run provider A against provider B's model id (on
    // this device: clawai's bare `deepseek-v4-pro` against anthropic).
    if (
      wantsProvider
      && !rawModel
      && payload.current.provider
      && payload.current.provider !== rawProvider
    ) {
      return NextResponse.json(
        { error: `No model is available for provider "${rawProvider}"` },
        { status: 409 },
      );
    }
  }

  // A message starting with "-" gets a leading space so hermes reads it as the
  // prompt value (the UI shows ClawBox's own copy of the message, not this one).
  const safeMessage = message.startsWith("-") ? ` ${message}` : message;
  // `chat -q` (single query, non-interactive) NOT `-z` (one-shot). Verified
  // on-device: `-z` starts a brand-new session every invocation and ignores
  // --resume, so every turn met an agent with no history — a follow-up like
  // "is it removed now?" was answered with "what are we trying to remove?".
  // `chat -q` threads: resuming returns the SAME session id and the prior
  // turns are in context. `-Q` is its documented programmatic/quiet mode.
  // ── Images ──────────────────────────────────────────────────────────────
  //
  // Two mechanisms, both native to the agent and both verified against the
  // checkout on the live box (`~/.hermes/hermes-agent` @ 1091472, 2026-08-22):
  //
  //   1. `--image IMAGE  Optional local image path to attach to a single
  //      query` — one image, explicit, straight into the request.
  //   2. `agent/image_routing.py:extract_image_refs()` scans the PROMPT for
  //      absolute or `~/`-rooted paths with a picture extension that exist on
  //      disk, skipping anything inside backticks or a fence, and `cli.py`
  //      dedupes the result against `--image`. So the extras ride as one bare
  //      path per line.
  //
  // (The old "attachments are OpenClaw-only" note in the composer was about
  // `-z/--oneshot`, which really does take no image flag. This route stopped
  // using `-z` when it needed session threading, and `chat` has had `--image`
  // all along.)
  //
  // Every path is re-resolved against the staging root here rather than
  // trusted from the body: it is about to become an argv element, and the
  // agent opens any readable absolute path it is handed.
  const requestedImages = Array.isArray(body.imagePaths)
    ? body.imagePaths.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_IMAGES_PER_TURN)
    : [];
  const imagePaths: string[] = [];
  for (const requested of requestedImages) {
    const safe = await resolveInMediaRoot(requested);
    // A path that does not resolve is dropped rather than 400-ing the turn.
    // The alternative is worse than it sounds: the staging tree is swept on a
    // retention schedule, so a file that aged out between being attached and
    // being sent would turn an ordinary message into a failed one.
    if (safe && !imagePaths.includes(safe)) imagePaths.push(safe);
  }
  const [firstImage, ...extraImages] = imagePaths;

  const promptWithImages = extraImages.length
    ? `${safeMessage}\n\n${extraImages.join("\n")}`
    : safeMessage;

  // ── The transcript ──────────────────────────────────────────────────────
  //
  // The QUESTION is recorded before the child is spawned, so a turn whose
  // process dies mid-run leaves a question with no answer — visibly incomplete
  // — rather than vanishing or, worse, leaving an answer to nothing. It is also
  // why this is written here and not in the browser: a customer who closes the
  // tab on a 600-second turn still gets the exchange back on their next visit.
  await appendTranscript({
    role: "user",
    text: typeof body.displayText === "string" && body.displayText.trim()
      ? body.displayText.trim()
      : message,
    timestamp: Date.now(),
    ...(imagePaths.length ? { media: imagePaths.map((p) => mediaUrl(p)) } : {}),
  });

  const args = ["chat", "-q", promptWithImages, "-Q"];
  if (firstImage) args.push("--image", firstImage);
  // No model → omit -m and let hermes use config.yaml's model.default, which is
  // by definition valid for the configured provider. (The previous hardcoded
  // `openai/gpt-4o-mini` fallback was actively wrong on a ClawBox AI device:
  // model.provider=clawai only accepts BARE deepseek ids and answers a
  // vendor-prefixed one with HTTP 400 "Model not allowed".)
  if (rawModel) args.push("-m", rawModel);
  // Names are charset-checked in smallLocalModelToolsets(), so this can never
  // carry a leading "-" into argv.
  if (slimToolsets) args.push("-t", slimToolsets.join(","));
  if (wantsProvider) args.push("--provider", rawProvider);
  if (rawReasoning) args.push("--reasoning", rawReasoning);
  // Continue the SAME conversation. Without this every turn is a fresh `-z`
  // run with its own session, so the agent has no idea what "it" refers to in
  // a follow-up — asking "is it removed now?" got "what are we trying to
  // remove?". We resume by explicit ID, never `--continue <name>`: that flag
  // ignores the name and silently resumes the most recent session in the
  // workspace, which would splice unrelated chats (and the agent's own cron
  // runs) into each other.
  if (rawSessionId) args.push("--resume", rawSessionId);

  // ── The fast path ───────────────────────────────────────────────────────
  //
  // Try the already-running dashboard first, and only when the caller asked to
  // be streamed to. Opening the socket and settling the session costs about a
  // tenth of a second and answers "can this box stream?" honestly, so a box
  // where it cannot falls through to the spawn below having lost nothing.
  //
  // Attachments stay on the CLI path deliberately: `--image` is a flag on that
  // command, and `prompt.submit` takes its attachments through a separate
  // `image.attach` handshake this route has not been taught. A turn carrying a
  // picture is rare and already slow; correctness first.
  if (wantsStream(request) && imagePaths.length === 0) {
    const turn = await openDashboardTurn({
      text: promptWithImages,
      ...(rawModel ? { model: rawModel } : {}),
      ...(wantsProvider ? { provider: rawProvider } : {}),
      ...(rawReasoning ? { reasoning: rawReasoning } : {}),
      ...(rawSessionId ? { sessionId: rawSessionId } : {}),
      signal: request.signal,
    });
    if (turn) return streamTurn(turn, rawSessionId);
  }

  try {
    const { out: text, err } = await runHermes(args, request.signal);
    // The run reports its own session id on stderr — no DB race, no guessing
    // from `sessions list`. Hand it back so the next turn can resume it.
    const threaded = parseSessionId(err) || rawSessionId;
    // The CLI path runs exactly what argv asked for — `-m` and `--provider` are
    // passed straight to the command, with no session to drift from — so the
    // request IS the record here. When no model was named, the run used
    // config.yaml's default and this route does not presume to name it.
    const answered = await settleTurn(threaded, text, "", {
      ...(rawModel ? { model: rawModel } : {}),
      ...(wantsProvider ? { provider: rawProvider } : {}),
    });
    return NextResponse.json(answered);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Client hit Stop / disconnected; the child was already killed. Nothing
      // is recorded: the user cancelled, and the question they typed is already
      // in the transcript above where an unanswered question belongs.
      return new NextResponse(null, { status: 499 });
    }
    const detail = err instanceof Error ? err.message : "Hermes chat failed";
    // A failure is recorded too. Without this a refresh shows a question with
    // nothing under it and no hint that the box tried and failed — the same
    // screen a still-running turn produces, which is the worse of the two to
    // be wrong about.
    await appendTranscript({
      role: "system",
      text: `Error: ${detail}`,
      timestamp: Date.now(),
      variant: "error",
    });
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
