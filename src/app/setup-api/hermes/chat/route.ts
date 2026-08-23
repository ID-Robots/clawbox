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
  providerHasBinaryReasoning,
  providerHasReasoningControl,
  isHermesReasoningLevel,
  isReasoningLevelAllowedFor,
} from "@/lib/hermes-reasoning";
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
import { extractReasoningPanels } from "@/lib/hermes-reasoning-panel";
import { readHermesTurn } from "@/lib/harness/hermes-turn-record";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";

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

/** Bookkeeping and stack noise, dropped before we look for a cause. */
function usefulLines(stream: string): string[] {
  const lines = stream
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^session_id:/i.test(l) && !/^\s*(?:Traceback|File ")/.test(l));
  const named = lines.filter((l) =>
    /\b(?:HTTP\s+\d{3}|error|failed|not found|denied|invalid|unauthor)/i.test(l));
  return (named.length ? named : lines).map((l) => l.slice(0, 400));
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
      rawReasoning = clampReasoningForProvider(effectiveProvider, rawReasoning);
    } else if (
      rawReasoning
      && isHermesReasoningLevel(rawReasoning)
      && !isReasoningLevelAllowedFor(effectiveProvider, rawReasoning)
    ) {
      return NextResponse.json(
        {
          error: `Provider "${effectiveProvider}" does not support the "${rawReasoning}" reasoning effort.`,
          allowed: hermesReasoningLevelsFor(effectiveProvider),
        },
        { status: 400 },
      );
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

  try {
    const { out: text, err } = await runHermes(args, request.signal);
    // The run reports its own session id on stderr — no DB race, no guessing
    // from `sessions list`. Hand it back so the next turn can resume it.
    const threaded = parseSessionId(err) || rawSessionId;
    // ── Answer, thinking and tool steps, pulled apart ─────────────────────
    //
    // TWO SOURCES, IN THIS ORDER, and the order is the whole point.
    //
    // What `chat -q … -Q` prints is a console rendering, and on this hardware
    // it is a lossy one. Captured from the live box with deepseek-v4-flash, a
    // bare "Hey" arrives as an OPENED reasoning frame that is never closed, the
    // monologue printed TWICE by two different producers, then the answer — and
    // no tool activity at all, because quiet mode prints none. Nothing in that
    // stream marks where thinking stops and the reply starts, so the parser
    // below can only ever handle the closed, framed case.
    //
    // The agent already has it right. `~/.hermes/state.db` stores the same turn
    // as `content`, `reasoning_content` and `tool_calls` in separate columns,
    // deduplicated, which is exactly the split the UI wants. So we ask the
    // agent's own record first, keyed by the session id it just reported, and
    // keep the console parse as the floor under it.
    const consoleReply = extractReasoningPanels(text);
    const record = await readHermesTurn(threaded);
    const answer = record?.text ?? consoleReply.text;
    const reasoning = record?.reasoning ?? consoleReply.reasoning;
    const toolCalls = record?.toolCalls;
    // The ANSWER, and only on success. Media is split here rather than stored
    // raw so that the record holds exactly what the bubble renders, and a
    // refreshed transcript is byte-identical to the live one instead of showing
    // a MEDIA: directive as text.
    const reply = splitAssistantMedia(answer);
    await appendTranscript({
      role: "assistant",
      text: reply.text,
      timestamp: Date.now(),
      ...(reply.images.length ? { media: reply.images } : {}),
      ...(reply.audio.length ? { audio: reply.audio } : {}),
      // Persisted beside the answer, never inside it: replay has to be able to
      // collapse the monologue the same way the live turn did.
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    });
    return NextResponse.json({
      text: answer,
      harness: "hermes",
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(threaded ? { sessionId: threaded } : {}),
    });
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
