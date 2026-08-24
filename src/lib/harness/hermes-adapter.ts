import { splitAssistantMedia } from "@/lib/chat-media";
import type { ChatToolSummary } from "@/lib/chat-history-cache";
import { HERMES_AUTO_PROVIDER, hermesProviderLabel } from "@/lib/hermes-providers";
import {
  asHarnessError,
  HarnessError,
  type FetchLike,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessStatus,
  type HistoryMessage,
  type HistoryOptions,
  type HistoryPage,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from "./transport";

/**
 * The Hermes side of the transport: one HTTP turn per message, threaded by a
 * session id the box echoes back.
 *
 * This adapter OWNS the three refs that used to sit in the chat component —
 * the resumed session id and the provider/model the last turn actually ran on.
 * All three describe "what the transport did last", which is why keeping them
 * in the component is what made the new-chat reset a component-level patch in
 * the first place: the button had to reach into transport state to clear it.
 * Here, "start a new chat" is one method call.
 */

/** What the chat header knows that a turn needs, read at send time. */
export interface HermesTurnContext {
  /**
   * The device's own configured pairing (`config.yaml` model.provider /
   * model.default). It is the floor: the only pairing that may be assumed
   * without a live model list.
   */
  devicePairing: { provider: string; model: string };
  /** Whether the selected provider's model list has arrived yet. */
  modelsReady: boolean;
}

const CHAT_ROUTE = "/setup-api/hermes/chat";
const TRANSCRIPT_ROUTE = "/setup-api/chat/history";

/**
 * How long a transcript call may take before it is abandoned.
 *
 * The request never leaves the box, but the box is an embedded Jetson whose own
 * HTTP server can stall under load — and neither of these calls carried a
 * deadline, so a stall left the awaiting caller pending with nothing to report
 * and nothing to retry. Both `catch` arms already treat a failure as non-fatal,
 * so a timeout lands on a path that exists.
 */
const TRANSCRIPT_TIMEOUT_MS = 10_000;

/**
 * Tool steps off the wire, re-validated rather than trusted.
 *
 * The route builds these from the agent's own database, but they arrive here as
 * JSON like anything else and are about to be rendered — so the shape is
 * checked here too. A malformed entry is dropped, never rendered as `undefined`.
 */
function toToolSummaries(value: unknown): ChatToolSummary[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolSummary[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : "";
    if (!name) continue;
    const detail = typeof row.detail === "string" ? row.detail : "";
    const status = row.status === "ok" || row.status === "error" ? row.status : undefined;
    calls.push({ name, ...(detail ? { detail } : {}), ...(status ? { status } : {}) });
  }
  return calls;
}

/**
 * One row off the wire, or not a message at all.
 *
 * The store is a file on a disk a shell can reach and the route re-validates
 * on the way out, but this is the last gate before a value becomes a rendered
 * bubble, and a `role` the UI has no branch for renders as nothing at all —
 * a silently missing message rather than a visible fault.
 */
function isHistoryMessage(row: unknown): row is HistoryMessage {
  if (!row || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  return (
    (value.role === "user" || value.role === "assistant" || value.role === "system") &&
    typeof value.text === "string" &&
    typeof value.timestamp === "number"
  );
}

/** Is this the streamed answer, or the ordinary one-shot JSON body? */
function isEventStream(res: { headers?: { get(name: string): string | null } }): boolean {
  return (res.headers?.get("content-type") || "").includes("text/event-stream");
}

/**
 * Read a streamed turn, painting it as it arrives and returning what the JSON
 * path would have returned.
 *
 * The frames are server-sent events with three names, and the split matters:
 * `delta` carries a FRAGMENT of the answer and nothing else — the route never
 * forwards the model's monologue on this channel — while `done` carries the
 * settled turn, which is the only thing that has the tool steps and the
 * deduplicated thinking. So the caller sees text appear immediately and still
 * ends up with exactly the record the non-streaming path would have produced.
 *
 * Fragments are accumulated here rather than passed on raw, because `TurnEvent`
 * says a delta is the answer SO FAR. One renderer, both harnesses.
 *
 * A stream that ends without a `done` is a failure, not an empty answer: the
 * connection dropped mid-turn, and silently resolving with the partial text
 * would record a truncated reply as if the agent had finished.
 */
async function readStreamedTurn(
  res: Response,
  // OPTIONAL, because the route can stream to a caller that never asked: a
  // proxy that upgrades the response, or a version skew between the two halves
  // of an upgrade. The adapter only ASKS when someone is listening, but what it
  // asked for does not decide what arrives — and a non-null assertion here
  // turned that case into a TypeError that lost a turn the box had already run.
  onEvent?: (event: TurnEvent) => void,
): Promise<Record<string, unknown>> {
  const body = res.body;
  if (!body) throw new HarnessError("upstream", "Hermes streamed an empty response");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let settled: Record<string, unknown> | null = null;
  let failure = "";

  const consume = (frame: string) => {
    let name = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      // The space after the colon is part of the framing, not the payload.
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
    } catch {
      // A frame we cannot read is dropped rather than failing the turn: the
      // authoritative record still arrives on `done`.
      return;
    }
    if (name === "delta") {
      const chunk = typeof payload.text === "string" ? payload.text : "";
      if (!chunk) return;
      answer += chunk;
      onEvent?.({ kind: "delta", text: answer });
    } else if (name === "done") {
      settled = payload;
    } else if (name === "error") {
      failure = typeof payload.error === "string" && payload.error ? payload.error : "Hermes chat failed";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line. Split on what is complete and keep
    // the remainder — a chunk boundary lands mid-frame constantly.
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      consume(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);

  if (failure) throw new HarnessError("upstream", failure);
  if (!settled) throw new HarnessError("upstream", "The reply was cut off before it finished.");
  return settled;
}

/**
 * The response body as an object, or an empty one.
 *
 * A route is not obliged to answer JSON — an upstream can interpose an HTML
 * error page, and a 503 may carry no body at all. Callers here only ever read
 * named fields off the result, so an empty object is the honest stand-in and
 * lets the STATUS decide what went wrong.
 */
async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await res.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class HermesAdapter implements HarnessAdapter {
  readonly id = "hermes" as const;

  /**
   * The Hermes session this chat is threaded through. Empty until the first
   * reply reports one; every later turn resumes it, which is what gives the
   * conversation memory.
   */
  private sessionId = "";
  /** The in-flight turn, so Stop can abort it. */
  private inFlight: AbortController | null = null;
  private readonly statusListeners = new Set<(s: HarnessStatus, detail?: string) => void>();

  constructor(
    readonly capabilities: HarnessCapabilities,
    private readonly context: () => HermesTurnContext,
    /** See the note on the gateway adapter: the narrow call, not `typeof fetch`. */
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /**
   * There is nothing to hold open, so this reports connected and resolves.
   *
   * The chat used to do exactly this inline, and it read as a lie: a component
   * that says "connected" with no socket behind it. It is the same answer here,
   * but it is now the adapter's answer and it comes with
   * `capabilities.hasLiveConnection === false`, which tells the UI not to
   * render a connection banner at all rather than to render a green one about
   * a wire that does not exist.
   */
  async connect(): Promise<void> {
    this.emit("connected");
  }

  disconnect(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }

  onStatus(cb: (status: HarnessStatus, detail?: string) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private emit(status: HarnessStatus, detail?: string) {
    for (const cb of this.statusListeners) cb(status, detail);
  }

  async sendTurn(req: TurnRequest, onEvent?: (event: TurnEvent) => void): Promise<TurnResult> {
    // Ask to be streamed to only when both halves are true: this box can do it
    // (`capabilities.streamsTurns`, probed) AND the caller is listening. The
    // route honours the header when it can and answers with ordinary JSON when
    // it cannot, so asking is never a commitment — see `readStreamedTurn`.
    const streaming = this.capabilities.streamsTurns && typeof onEvent === "function";
    const controller = new AbortController();
    this.inFlight = controller;
    const abortFromCaller = () => controller.abort();
    // A signal that is ALREADY aborted never fires its event again, so a Stop
    // that landed between building the turn and sending it would otherwise be
    // ignored and the request would go out anyway.
    if (req.signal?.aborted) controller.abort();
    else req.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const provider = req.provider ?? "";
    const model = req.model ?? "";
    const reasoning = req.reasoning ?? "";
    const ctx = this.context();
    try {
      if (provider && provider !== HERMES_AUTO_PROVIDER && !model && provider !== ctx.devicePairing.provider) {
        // Sending --provider without -m makes hermes fall back to config.yaml's
        // model.default, which belongs to the CONFIGURED provider — i.e. it
        // would run this provider against another one's model id. The route
        // rejects that too (409); catching it here turns a raw error into an
        // actionable one instead of burning a turn.
        throw new HarnessError(
          "invalid-input",
          ctx.modelsReady
            ? `No models are available for ${hermesProviderLabel(provider)} on this device. ` +
              "Add credentials for it in Settings, or pick another provider."
            : `Still loading ${hermesProviderLabel(provider)}'s models — try again in a moment.`,
        );
      }
      // A mid-conversation switch is a TRANSPORT concern, and it is now handled
      // as one: the chat route re-points the live session at the new
      // model/provider before submitting the prompt (`/model … --session` on
      // the dashboard socket — see hermes-dashboard-turn).
      //
      // This used to prepend a "[System note: this conversation has just been
      // switched to model …]" paragraph to the customer's own message instead.
      // It was never true. Nothing was switched — the resume call dropped the
      // override — so the note asked the model to claim a change that had not
      // happened, and the model, being asked in the message body rather than
      // told by its harness, correctly refused: "That 'system note' arrived
      // inside your chat message, not from my actual harness — my real session
      // configuration still says claude-fable-5." Configuration is never
      // message content; the message is now exactly what the customer typed.
      const outbound = req.text;
      const res = await this.fetchImpl(CHAT_ROUTE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A request, not a demand. The route streams when the box can and
          // answers JSON when it cannot, and both are handled below.
          ...(streaming ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify({
          message: outbound,
          // Staged absolute paths. The route re-resolves every one of them
          // against the staging root before any of it reaches argv — this side
          // is a convenience, not a check.
          ...(req.attachments.length
            ? { imagePaths: req.attachments.map((a) => a.path) }
            : {}),
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(reasoning ? { reasoning } : {}),
          // Continue this conversation instead of starting a fresh agent every
          // turn — otherwise a follow-up like "is it removed now?" reaches an
          // agent with no idea what "it" is.
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        }),
        signal: controller.signal,
      });
      // A streamed answer is read frame by frame; anything else is one JSON
      // body. The CONTENT TYPE decides, not what we asked for — the route falls
      // back to spawning the CLI whenever the box cannot stream this minute,
      // and that answer must still be understood.
      //
      // The JSON side is read defensively, and the status is branched on below
      // rather than above: parsing first meant a non-JSON error body — a
      // proxy's HTML 502, an empty 503 — rejected inside `res.json()`, and the
      // catch relabelled it `upstream` carrying the parser's text, so a 409
      // reached the user as "Unexpected token <" instead of the actionable
      // `invalid-input` the route actually sent.
      const data = isEventStream(res)
        ? await readStreamedTurn(res, onEvent)
        : await readJsonBody(res);
      // Reading the body is where a Stop most often lands — it is the long
      // part of the turn on both paths. A failed parse and an abandoned stream
      // both come back as an empty object, which would otherwise sail on and
      // be returned as a successful turn with no text; the run has to end as
      // the abort it was.
      if (controller.signal.aborted) throw new HarnessError("aborted", "Stopped.");
      if (!res.ok) {
        throw new HarnessError(
          res.status === 409 || res.status === 400 ? "invalid-input" : "upstream",
          typeof data?.error === "string" && data.error ? data.error : "Hermes chat failed",
        );
      }
      if (typeof data.sessionId === "string" && data.sessionId) {
        this.sessionId = data.sessionId;
      }
      // Same MEDIA: split as the gateway path, so a picture renders the same
      // way whichever edition answered.
      const reply = splitAssistantMedia(typeof data.text === "string" ? data.text : "");
      // Thinking and tool steps ride BESIDE the answer. The route separated
      // them from the CLI's console output (or, where it could, read them
      // straight out of the agent's own record); folding them back into `text`
      // here would put the monologue right back in the bubble.
      // Named for what it IS — the monologue that came BACK — because
      // `reasoning` in this scope is already the effort level we sent.
      const thinking = typeof data.reasoning === "string" && data.reasoning ? data.reasoning : "";
      const toolCalls = toToolSummaries(data.toolCalls);
      return {
        text: reply.text,
        media: reply.images,
        audio: reply.audio,
        ...(thinking ? { reasoning: thinking } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    } catch (err) {
      throw asHarnessError(err, "upstream");
    } finally {
      req.signal?.removeEventListener("abort", abortFromCaller);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /** Aborting the fetch makes the route see `request.signal` fire, which kills
   *  the child process and answers 499. Already wired end to end. */
  async abortTurn(): Promise<void> {
    this.inFlight?.abort();
  }

  /**
   * Forgetting the resumed session id IS the reset.
   *
   * The next message goes out with no `--resume`, so `hermes chat -q` opens a
   * fresh session on the box and the agent genuinely does not have the old
   * conversation. The provider/model the last turn ran on go with it: they
   * describe the conversation that just ended, and a stale pair would make the
   * first turn of the new one announce a "switch" that never happened.
   *
   * Idempotent, and never rejects — the (+) button is double-clickable, and
   * there is no request here that could fail.
   */
  async resetSession(): Promise<void> {
    this.sessionId = "";
    // …and the replay log with it. Clearing only the session id would make the
    // agent forget while the screen refilled with the old conversation on the
    // next refresh — the worst of both, and exactly the split the durable
    // transcript could introduce if the two halves of "forget" ever drifted.
    //
    // Deliberately not fatal. The agent has ALREADY forgotten by the time this
    // runs (the three lines above are the reset that matters), so throwing here
    // would report a failed reset that in fact succeeded, and the (+) button is
    // double-clickable precisely so this stays idempotent.
    try {
      const res = await this.fetchImpl(TRANSCRIPT_ROUTE, {
        method: "DELETE",
        signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn("[hermes-adapter] could not clear the stored transcript:", res.status);
      }
    } catch {
      console.warn("[hermes-adapter] could not reach the transcript store to clear it");
    }
  }

  /**
   * The conversation as the box recorded it, so a refresh does not empty a
   * screen the agent still remembers.
   *
   * This reads OUR replay log, never the agent's own session database. The two
   * answer different questions and only one of them may decide what is drawn:
   * see the note at the top of `transcript-store.ts`.
   */
  async loadHistory(options?: HistoryOptions): Promise<HistoryPage> {
    const limit = options?.limit ?? 50;
    try {
      const res = await this.fetchImpl(`${TRANSCRIPT_ROUTE}?limit=${encodeURIComponent(String(limit))}`, {
        // The transcript is the one thing on this surface that MUST NOT be
        // served from a cache: a reset writes an empty store and a stale 200
        // would repaint the conversation the user just deleted.
        cache: "no-store",
        signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new HarnessError("upstream", "Could not read the stored transcript.");
      }
      const data = await res.json();
      const rows = Array.isArray(data?.messages) ? data.messages : [];
      return {
        messages: rows.filter(isHistoryMessage),
        // There is no image-generation wait to resolve on this path: the
        // OpenClaw failure notice this reports is a gateway artefact with no
        // Hermes equivalent, so the honest answer is always "no verdict".
        imageGenerationFailed: false,
      };
    } catch (err) {
      throw asHarnessError(err, "upstream");
    }
  }

  async patchSessionDefaults(_patch: { thinkingLevel?: string | null }): Promise<void> {
    void _patch;
    // Hermes carries its reasoning level on the turn itself
    // (`capabilities.reasoningScope === 'per-turn'`), so there is nothing
    // sticky to patch. Never called: `canPatchSessionDefaults` is false and
    // `shouldPatchSessionDefaults` checks it first.
    throw new HarnessError("unsupported", "This harness has no sticky session defaults.");
  }

  /** Test seam: the session id this chat is currently threaded through. */
  get threadedSessionId(): string {
    return this.sessionId;
  }
}
