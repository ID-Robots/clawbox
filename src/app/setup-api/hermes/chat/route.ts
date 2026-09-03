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
  cachedModelOptions,
  getModelOptions,
  isAllowedProvider,
  isPairAllowed,
  shouldEnforcePairing,
  readCurrentFromCli,
  type ModelOptionsPayload,
} from "@/lib/hermes-model-options";
import { appendTranscript } from "@/lib/harness/transcript-store";
import { DESKTOP_TRANSCRIPT_KEY, transcriptKeyIsSafe } from "@/lib/harness/transcript-key";
import { resolveInMediaRoot } from "@/lib/harness/media-root";
import { mediaUrl, splitAssistantMedia } from "@/lib/chat-media";
import { splitEmailRefs } from "@/lib/chat-email-refs";
import { extractReasoningPanels, stripAgentStatusFrames } from "@/lib/hermes-reasoning-panel";
import {
  readHermesBillingProvider,
  readHermesTurn,
  readHermesUsageMarks,
} from "@/lib/harness/hermes-turn-record";
import {
  adoptHermesGeneratedImages,
  reclaimImageMentions,
  servableMediaRoot,
} from "@/lib/harness/hermes-generated-media";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";
import { speakHermesReply } from "@/lib/harness/hermes-spoken-reply";
import { hermesSpeaksReplies } from "@/lib/hermes-tts";
import {
  DASHBOARD_PROVIDER_KIND,
  isQuietStreamError,
  openDashboardTurn,
  type DashboardTurn,
} from "@/lib/hermes-dashboard-turn";
import {
  errorFromStderr,
  hermesFailureMessage,
  safeHermesFailureMessage,
  spawnFailureMessage,
} from "@/lib/hermes-cli-message";

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
      // EVERY spawn failure carries the full binary path in its message
      // (`spawn /home/clawbox/.local/bin/hermes EACCES`), not just ENOENT —
      // and this message becomes the chat bubble, the 502 body AND the durable
      // transcript line. Sanitising one errno and passing the rest through was
      // the whole of the leak. Keep the raw text in the journal, where a path
      // is a diagnosis rather than a disclosure.
      console.error("[hermes chat] spawn failed", e);
      reject(new Error(spawnFailureMessage(e)));
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

// The failure-message parser lives in @/lib/hermes-cli-message: the Settings
// panel renders the same `hermes` stderr through two more routes, and a parser
// that only the chat route could reach is how the frames got back on screen.

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
  spawnFailureMessage,
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
  /** The transcript the answer is recorded under — ours, not the agent's. */
  sessionKey: string,
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
  // The reply, SPOKEN — the Hermes half of what the OpenClaw gateway does
  // unbidden. Said as a `MEDIA:` line for exactly the reason the picture above
  // is: `splitAssistantMedia` lifts it back out a few lines down into the same
  // `audio` array the gateway's attachment part produces, so the transcript,
  // the adapter and the bubble's player all keep working with no edition of
  // their own.
  //
  // The CAPTION is what gets spoken, not `answer`: the MEDIA: lines are
  // machinery, and a box reading a file path aloud would be absurd.
  //
  // `EMAIL:` is machinery for the same reason and loses the same way, so it
  // comes off the SPOKEN copy only. This is the one edition where the rule has
  // to be applied here: on OpenClaw the gateway synthesises the reply and
  // ClawBox never sees the text on its way to the voice, but on Hermes the clip
  // is built right here — so a caption that kept its directives had the box say
  // "EMAIL four four seven one" after the summary. `caption` itself is left
  // alone: `answer` below is the transcript, and the bubble's card is made from
  // exactly those lines.
  //
  // Fail-soft and bounded (see speakHermesReply): a reply that could not be
  // spoken still renders, silently. Losing the answer to a busy voice would be
  // a far worse trade than losing the audio.
  // The capability read is inside the try/catch of neither — `hermesSpeaksReplies`
  // fails closed and `speakHermesReply` never throws — so a box that cannot
  // answer the question simply does not speak, and the turn is unaffected.
  const spokenClip = (await hermesSpeaksReplies()) ? await speakHermesReply(splitEmailRefs(caption).text) : null;
  const answer = [
    caption,
    ...drawn.map((file) => `MEDIA:${file}`),
    ...(spokenClip ? [`MEDIA:${spokenClip}`] : []),
  ]
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
    // Which model actually answered, from the transport — the dashboard's
    // `info` for the session, read at the moment the turn was submitted, after
    // any switch had been applied and acknowledged. The PROVIDER beside it can
    // come from the agent's own record instead, and only where the transport
    // named none and the request asked for none: see `billedProviderFor`.
    //
    // ASKED, on the box, and the answer is on the record now.
    // `PRAGMA table_info(messages)` lists 23 columns and not one of them names
    // a model, a provider or a billing mode — so the row `readHermesTurn`
    // already opens genuinely cannot supply this, and the reconstruction
    // stands. `sessions` DOES carry `model` and `billing_provider`, but only
    // the LAST ones the thread used: reading them per bubble would relabel
    // every older reply in a conversation that switched, which is the defect
    // this field exists to prevent.
    //
    // What the harness can answer per (session, model) is
    // `session_model_usage.billing_provider` — see `billedProviderFor`, which
    // asks it for the one case nothing else can speak for.
    ...(served.model ? { model: served.model } : {}),
    ...(served.provider ? { provider: served.provider } : {}),
  }, sessionKey);
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
 *   `error` — the turn failed, and the message has been MADE customer-readable
 *             on the way out. It used to say "already", which was an assumption
 *             about Python text written on the other side of a socket — the
 *             exact assumption the CLI transport needed a 200-line parser to
 *             stop making. Both transports now hand their failure text to
 *             `safeHermesFailureMessage` before anyone sees it.
 *
 * Once the first byte is out the status code is spent, so a failure after that
 * point is reported inside the stream rather than as an HTTP error. Everything
 * that could have produced a clean 4xx/5xx has already run before this is called.
 */
/**
 * What answered, assembled under one rule: the model and the provider are never
 * taken from two different TRANSPORT reports. A half the transport left empty
 * may be filled from the harness's own billing record, and from nowhere else.
 *
 * The transport works hard to answer NOTHING rather than a pairing the turn did
 * not establish: `servedProviderSlug` declines a kind it cannot resolve, and a
 * completion frame that changes the model gets no provider at all, because the
 * settled provider belongs to the settled model. Reading the two halves with
 * independent `||`s undid all of it at the one place the answer is persisted —
 * a frame reporting `gpt-5.6-sol` with no provider was recorded as
 * `gpt-5.6-sol` beside the session's `clawai`, the invented pairing, in the
 * customer's durable transcript.
 *
 * So: a turn that reported a model owns both halves of the record, including
 * the half it left empty. Only a turn that reported no model at all — a
 * transport that never produced a frame, and the quiet-stream recovery, which
 * passes `null` — falls back to what the session was settled on.
 *
 * The half it left empty is then asked of the HARNESS, and only ever of the
 * harness — see `billedProviderFor`. That is not a retreat from the paragraph
 * above: it invents nothing and reads nothing about what was configured. It
 * asks Hermes what it billed for this session and this model, which is the one
 * source that can answer "who served that reply" as a fact.
 */
async function servedPair(
  final: { model?: string; provider?: string } | null,
  turn: DashboardTurn,
  /** The session the answer was recorded under — the key the harness bills by. */
  sessionId: string,
  /**
   * The session's billing marks from before this turn ran, or null for "do not
   * ask the harness" — either the request named a provider (see
   * `billedProviderFor`) or the baseline could not be taken.
   */
  usageBefore: ReadonlySet<string> | null,
): Promise<{ model?: string; provider?: string }> {
  const source = final?.model ? final : { model: turn.model, provider: turn.provider };
  const model = source.model || "";
  const provider = source.provider
    || (model && usageBefore ? await billedProviderFor(sessionId, model, usageBefore) : "");
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

/**
 * The provider Hermes itself recorded against this turn, for a turn the
 * customer pinned nothing on.
 *
 * THE CASE THIS EXISTS FOR is the ordinary new chat: press "+", type, send. The
 * request names neither half, so the transport has no contract to fall back on
 * — `servedProviderSlug` returns nothing without a requested provider — and the
 * dashboard's own frames name a model and no provider. Measured on the box,
 * three runs out of three: `done` carried `gpt-5.6-sol` with no `provider` key
 * and the durable transcript stored `provider=None`, while Hermes'
 * `session_model_usage` held `billing_provider='openai-codex'` for each of
 * those three session ids. The bubble said which model answered and could not
 * say who served it, and the answer was one read away.
 *
 * ONLY when the request named no provider. Where it did and the transport still
 * declined, the decline is the contradiction guard doing its job — a canonical
 * slug asked of a session the dashboard reports as the KIND `custom` — and this
 * must not talk over it. Nothing here loosens that guard; it answers the case
 * the guard was never about.
 *
 * NOT from `config.yaml` and NOT from the device default, which is the fix this
 * deliberately is not: what the box is configured to run is not evidence about
 * what this session ran, and reading it that way is exactly what the served-
 * model work removed.
 *
 * WHY THE STORE AND NOT THE WIRE, which is the question the harness-first rule
 * asks. Hermes exposes no other surface for this: `messages` has no such
 * column, `sessions` has only the thread's last one, the `session.usage` RPC's
 * params and result are undocumented, `/api/analytics/usage` is aggregated by
 * day and names no provider, the `/usage` slash command is prose, and
 * `--usage-file` is `-z`-only while `-z` ignores `--resume`. The ONE candidate
 * still open is the `session.usage` EVENT this transport already receives and
 * drops (`hermes-dashboard-turn.ts`, the frame loop's `default`): its payload
 * has never been captured, and if it carries the provider it is better than
 * this on every axis — per turn, pushed, no second store to open. That capture
 * is the next lane's, and it retires this function if it lands.
 */
async function billedProviderFor(
  sessionId: string,
  model: string,
  usageBefore: ReadonlySet<string>,
): Promise<string> {
  const billed = await readHermesBillingProvider(sessionId, model, usageBefore);
  // It is about to be persisted and rendered, so it is charset-checked like any
  // other provider id, even though it came from the box's own store.
  if (!billed || !isPlausibleHermesProviderId(billed)) return "";
  // `custom` is a KIND as well as a real slug and nothing here can tell the two
  // apart — the same refusal `servedProviderSlug` makes about the same word.
  if (billed === DASHBOARD_PROVIDER_KIND) return "";
  // A recorded pairing the catalogue calls impossible is not an answer about
  // this turn — but only where the catalogue really is an ENUMERATION. For a
  // provider it does not positively call built-in, the model list may be one
  // this repo seeded (`normalizeRow` does exactly that for the box's own
  // provider and the on-device one, from a single configured id), and vetoing
  // the harness's own record with a list we padded ourselves would blank the
  // label on the most common provider on the fleet. `isUserDefined === false`
  // is the only value that says "Hermes ships this one and listed its models".
  //
  // Cache only, never a fetch: this runs after the answer has streamed, and the
  // veto is waived anyway whenever the catalogue is unavailable or stale
  // (`shouldEnforcePairing` declines both), so waiting for one would hold the
  // `done` frame — and the durable transcript write with it — to maybe apply a
  // check that a failed fetch waives.
  const payload = cachedModelOptions();
  const row = payload?.providers.find((entry) => entry.id === billed);
  if (
    payload
    && row?.isUserDefined === false
    && shouldEnforcePairing(payload, billed)
    && !isPairAllowed(payload, billed, model)
  ) {
    return "";
  }
  return billed;
}

function streamTurn(
  turn: DashboardTurn,
  fallbackSessionId: string,
  sessionKey: string,
  /** Whether the REQUEST named a provider — see `billedProviderFor`. */
  requestNamedProvider: boolean,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const threaded = turn.sessionId || fallbackSessionId;
      // The session's billing rows BEFORE this turn writes any, so that
      // afterwards the ones it wrote can be told from the ones it did not —
      // see `pickBillingProvider`. Taken only for a turn that could need it,
      // and null means "do not ask": the request already named a provider, or
      // the store could not be read, and a missing baseline is not a baseline.
      // One small read against a store this route opens once more anyway.
      const usageBefore = requestNamedProvider ? null : await readHermesUsageMarks(threaded);
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
          // The dashboard's `payload.error` is Python-authored text off a
          // socket, no different in kind from the CLI's stderr — so it takes
          // the same road out. `final.text` is NOT a fallback for it: the
          // answer body is not an error message, and the transport caps it at
          // MAX_TEXT_BYTES (2,000,000), so using it wrote up to a two-megabyte
          // `Error: …` row into a customer's durable transcript where the CLI
          // branch would have capped the same failure at 400 characters.
          //
          // The raw frame stays in the journal, the pattern the provider-key
          // route already uses: the diagnosis is not lost, it just stops being
          // published.
          if (final.error) console.error("[hermes chat] dashboard turn failed", final.error);
          const detail = safeHermesFailureMessage("", final.error || "") || "Hermes chat failed";
          await appendTranscript({
            role: "system",
            text: `Error: ${detail}`,
            timestamp: Date.now(),
            variant: "error",
          }, sessionKey);
          send("error", { error: detail });
        } else {
          send(
            "done",
            await settleTurn(
              threaded,
              sessionKey,
              final.text,
              final.reasoning,
              await servedPair(final, turn, threaded, usageBefore),
            ),
          );
        }
      } catch (err) {
        // The sibling of the branch above, and it carries the SAME text from
        // the SAME place: hermes-dashboard-turn.ts rethrows the transport's
        // `error` frame as `new Error(payload.message)`. ClawBox-authored
        // failures thrown here (a quiet stream, a cancelled call) pass through
        // the parser unchanged — nothing in them looks like a traceback or a
        // path — so one treatment is right for both.
        const raw = err instanceof Error ? err.message : "";
        // Not for an abort: the socket died because the customer pressed Stop,
        // and a journal line per cancelled turn is noise, not diagnosis.
        if (raw && !isAbort(err)) console.error("[hermes chat] dashboard stream failed", raw);
        const detail = safeHermesFailureMessage("", raw) || "Hermes chat failed";
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
              await settleTurn(
                threaded,
                sessionKey,
                recovered.text,
                "",
                await servedPair(null, turn, threaded, usageBefore),
              ),
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
          }, sessionKey);
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

/**
 * What a `hermes chat -q` run served: the named half of the pair as named, the
 * other half as config.yaml has it. `-m` alone runs on the configured provider;
 * `--provider` alone is refused above unless it IS the configured one. A
 * default that cannot be read is left out rather than guessed.
 *
 * Read through `readCurrentFromCli`, never off the catalogue payload: that
 * payload is memoised whole (fresh under 60 s, served stale for hours with a
 * background refresh) and only ClawBox's own writers invalidate it — Hermes'
 * own `/model` persist and a `hermes config set` from a terminal do not. The
 * `hermes config get` read underneath is keyed on config.yaml's mtime, so it
 * costs a stat when nothing changed and cannot lag a write.
 *
 * NOT on a RESUMED run, though — `resuming` is the whole of the difference.
 * config.yaml's default is only what the run took when the run had nothing else
 * to take: a `--resume`d session can be carrying a per-session override, which
 * is exactly what the dashboard transport writes with `/model … --session`, and
 * one conversation moves between the two transports routinely (every turn with
 * an attachment is forced onto this one). So a resumed run records what argv
 * named and nothing else: unknown beats wrong, the same rule the dashboard half
 * follows.
 *
 * What argv named IS recorded there, and that is not the same guess. This
 * fallback exists because the customer picked a model the dashboard would not
 * switch to (see hermes-dashboard-turn.ts, the `slash.exec` refusal), and its
 * whole justification is that the spawned run answers on the picked pair. If
 * `-m` lost to a session override the ROUTING would be wrong, not just the
 * label — a much larger defect than this function. So the record follows the
 * assumption the fallback already rests on, rather than inventing a second one.
 * Unverified on a box all the same, and it is one read: `hermes chat --help`
 * plus one resumed turn with `-m`.
 *
 * The harness's billing record is deliberately NOT consulted here, though the
 * dashboard leg now reads it (`billedProviderFor`). Two cases blank the provider
 * on this path and neither is one the record can settle. On a RESUMED run the
 * lookup would be keyed on a model that is itself the unverified claim above, so
 * it either finds nothing or corroborates a label that was never the question.
 * On a non-resumed run the blank means `readCurrentFromCli` could not answer at
 * all — a spawn that timed out or a value that failed its charset check — and a
 * box whose `hermes config get` is not answering is not a box whose store should
 * be trusted to say who billed the turn it just ran. Leaving both is a choice
 * about scope, not a claim that nothing could be read: the dashboard transport
 * is what serves on this hardware, and it is where the defect was measured.
 */
async function cliServedPair(
  model: string,
  provider: string,
  resuming: boolean,
): Promise<{ model?: string; provider?: string }> {
  const complete = Boolean(model && provider);
  const current = complete || resuming ? null : await readCurrentFromCli();
  const servedModel = model || current?.model || "";
  const servedProvider = provider || current?.provider || "";
  return {
    ...(servedModel ? { model: servedModel } : {}),
    ...(servedProvider ? { provider: servedProvider } : {}),
  };
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
    /**
     * OURS, not the agent's. `sessionId` above is the Hermes session the turn
     * resumes; this names the transcript the turn is recorded under — the
     * desktop thread, or one of the tabs the chat opened beside it.
     */
    sessionKey?: string;
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
  // Becomes a filename in the transcript store, so it is held to the store's
  // own rule before anything is written under it.
  const sessionKey = typeof body.sessionKey === "string" && body.sessionKey
    ? body.sessionKey
    : DESKTOP_TRANSCRIPT_KEY;
  if (!transcriptKeyIsSafe(sessionKey)) {
    return NextResponse.json({ error: "Invalid session key" }, { status: 400 });
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
  }, sessionKey);

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
    // The catalogue knows which providers are user-defined; the transport
    // needs that one bit to read the dashboard's provider KIND honestly. Only
    // the LIVE catalogue knows it: the catalog-file fallback writes `false`
    // for every row (the manifest has no such column) and cold-start writes
    // `true` for its own — neither is the dashboard's `is_user_defined`, and a
    // wrong `false` would blank the label on the box's own provider.
    const providerRow = wantsProvider && payload?.source === "dashboard"
      ? payload.providers.find((row) => row.id === rawProvider)
      : undefined;
    // `source === "dashboard"` says where the payload came from, not that the
    // dashboard reported this field. A row that simply omits `is_user_defined`
    // normalises to null, and passing that on as `false` would blank the label
    // on the box's own provider — the hazard the comment above names.
    const reportedUserDefined = typeof providerRow?.isUserDefined === "boolean"
      ? providerRow.isUserDefined
      : undefined;
    const turn = await openDashboardTurn({
      text: promptWithImages,
      ...(rawModel ? { model: rawModel } : {}),
      ...(wantsProvider ? { provider: rawProvider } : {}),
      ...(reportedUserDefined === undefined ? {} : { providerIsUserDefined: reportedUserDefined }),
      ...(rawReasoning ? { reasoning: rawReasoning } : {}),
      ...(rawSessionId ? { sessionId: rawSessionId } : {}),
      signal: request.signal,
    });
    // `wantsProvider` and not `rawProvider`: "auto" is ClawBox's word for "let
    // Hermes decide", so a turn that sent it named no provider either, and the
    // harness's own record is precisely the answer to what it decided.
    if (turn) return streamTurn(turn, rawSessionId, sessionKey, wantsProvider);
  }

  // Read BEFORE the run, not after: the default this turn used is the one on
  // disk when it was spawned, and a switch made during the turn — ai_set_model
  // does exactly that when told "switch to X" — must not become the record of
  // the turn that was told.
  const cliServed = await cliServedPair(rawModel, wantsProvider ? rawProvider : "", Boolean(rawSessionId));

  try {
    const { out: text, err } = await runHermes(args, request.signal);
    // The run reports its own session id on stderr — no DB race, no guessing
    // from `sessions list`. Hand it back so the next turn can resume it.
    const threaded = parseSessionId(err) || rawSessionId;
    // The CLI path runs exactly what argv asked for — `-m` and `--provider` are
    // passed straight to the command, with no session to drift from — so the
    // request IS the record here. What it did NOT ask for, the run took from
    // config.yaml's pairing, which is the same read the validation above makes
    // when it has a reason to: recorded too, because a blank under a reply the
    // box knows the model of is a false unknown, not modesty.
    const answered = await settleTurn(threaded, sessionKey, text, "", cliServed);
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
    }, sessionKey);
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
