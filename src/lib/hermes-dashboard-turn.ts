import { WebSocket } from "ws";
import { DASHBOARD_WS_ORIGIN, dashboardWsTicket } from "@/lib/hermes-dashboard-auth";

/**
 * A Hermes turn driven through the dashboard's own JSON-RPC socket instead of a
 * fresh `hermes chat -q` process.
 *
 * WHY THIS EXISTS, measured rather than assumed. On the live box a `chat -q`
 * turn spends about six seconds building an agent — importing the CLI, handshaking
 * the MCP server, assembling the system prompt — BEFORE the first request to the
 * model is even sent. On a "Hey" against deepseek-v4-flash that was 6.0s of boot
 * around 2.9s of model time: the wait a person feels is mostly a process starting
 * up, not a model thinking.
 *
 * The `hermes dashboard` process (127.0.0.2:9119) has already paid that cost and
 * is sitting there. Its `/api/ws` endpoint is the same JSON-RPC surface its own
 * Chat tab drives, and the agent runs INSIDE it, so a turn submitted here starts
 * against the model immediately and streams back token by token — the same
 * internal `stream_delta_callback` that makes Telegram replies type themselves out.
 * Measured on the same prompt and model: first visible text at 2.9s instead of
 * 8.4s, whole turn 3.0s instead of 9.8s.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not become the source of the turn
 * record. The final answer, its reasoning and its tool steps are still read from
 * the agent's own database by `readHermesTurn`, exactly as the CLI path reads
 * them, because that record is the one the transcript keeps and it is already
 * proven. This module's job is the two things the database cannot give in time:
 * the text as it arrives, and the session id to read afterwards.
 */

/** The dashboard's own event names, kept as a set so a rename is one edit. */
const EVENT = {
  ready: "gateway.ready",
  messageStart: "message.start",
  /** A fragment of the ANSWER. Never carries the monologue — see `reasoningDelta`. */
  messageDelta: "message.delta",
  messageComplete: "message.complete",
  /**
   * A fragment of the model's private reasoning, on its OWN channel.
   *
   * This is the whole reason the raw monologue cannot flash into the bubble on
   * this transport: the separation is made at the source rather than recovered
   * afterwards by parsing a console frame out of stdout. Nothing here forwards
   * it, and that is a property of the wire, not of a filter we have to keep
   * correct.
   */
  reasoningDelta: "reasoning.delta",
  /**
   * NOT reasoning. The agent's animated STATUS LINE — the spinner text.
   *
   * Upstream is explicit about this. `thinking_callback` is documented as the
   * live status line ("CLI: updates the prompt_toolkit spinner text. TUI /
   * Desktop: the same callback is bridged to the `thinking.delta` event, which
   * both render as the live spinner/status line" — run_agent.py `_emit_wait_notice`),
   * and the gateway wires it straight through: `"thinking_callback": lambda text:
   * _emit("thinking.delta", sid, {"text": text})` (tui_gateway/server.py). What
   * it carries is composed in agent/conversation_loop.py as `f"{face} {verb}..."`
   * from a fixed kaomoji list and a fixed verb list (agent/display.py:
   * KAWAII_THINKING / THINKING_VERBS).
   *
   * So this channel emits things like `(⌐■_■) computing...` — for EVERY model,
   * including ones that do no reasoning at all. Collecting it alongside
   * `reasoning.delta` put exactly that in the customer's Reasoning disclosure:
   * a turn on claude-fable-5 (which returned no monologue) showed
   * `(⊙_⊙) musing...` as though the model had thought it.
   *
   * It is named here so the frame is recognised and deliberately dropped,
   * rather than falling to `default` and being reported as unknown. Excluded at
   * the SOURCE — no regex scrubs a status vocabulary out of reasoning text
   * afterwards, because the wire already tells us which channel is which.
   */
  thinkingDelta: "thinking.delta",
  /**
   * The agent is BLOCKED, asking a person whether a tool may run.
   *
   * This is the one thing the socket does that spawning `hermes chat -q` never
   * did, and it is not cosmetic: the agent thread parks on an Event until an
   * answer comes back, so a client that treats this as just another event to
   * ignore hangs the turn forever. Found exactly that way — a live turn that
   * logged its first model call and then nothing at all, for minutes, with no
   * turn-finished line.
   */
  approvalRequest: "approval.request",
  error: "error",
} as const;

/**
 * What we answer an approval with, and why it is "approve".
 *
 * Not a new permission — the SAME one this route already grants. `chat -q`
 * runs the agent with no person attached and its tools execute unprompted;
 * that is what a customer typing into this chat gets today, and the security
 * scan that blocks the genuinely dangerous classes runs underneath either way.
 * Answering "deny" here would quietly make the chat LESS capable than it was
 * before it got faster, which is the wrong kind of surprise: the same request
 * that worked yesterday would come back refused.
 *
 * `once` rather than `always` or `session`: the grant covers the call being
 * asked about and nothing beyond it, so nothing this route answers can widen
 * what a later turn — or the owner's own dashboard session — may do.
 */
const APPROVAL_CHOICE = "once";

/**
 * How long a turn may go with NOTHING arriving before we call it dead.
 *
 * Idle, not total: a turn that is actively streaming is alive by definition and
 * must never be cut off for taking a long time, which is exactly what a blanket
 * deadline does to the long answers most worth waiting for. The clock restarts
 * on every frame — including `reasoning.delta`, so a model that thinks for two
 * minutes before writing a word still counts as working.
 */
const IDLE_TIMEOUT_MS = Number(process.env.HERMES_STREAM_IDLE_TIMEOUT_MS || 180_000);

/** Bound on the handshake itself, which is local and answers in milliseconds. */
const CONNECT_TIMEOUT_MS = 8_000;

/** Name every frame this module chose not to act on. Off unless asked. */
const DEBUG_FRAMES = process.env.HERMES_STREAM_DEBUG === "1";

/** Bound on `session.create` / `session.resume`, likewise local. */
const SESSION_TIMEOUT_MS = 15_000;

/**
 * Bound on a mid-conversation `/model` switch.
 *
 * Wider than the session calls because it is not just bookkeeping: the switch
 * rebuilds the agent's client against the new provider, measured at ~3.3s on
 * the bench box. Generous enough that a slow rebuild still lands, tight enough
 * that a wedged one does not eat the turn.
 */
const SWITCH_TIMEOUT_MS = 20_000;

/**
 * The most answer text we will hold. The route caps the CLI's stdout the same
 * way and for the same reason: a runaway turn must not be able to grow the
 * server's heap without limit.
 */
const MAX_TEXT_BYTES = 2_000_000;

/**
 * How long a "can this box stream?" answer is trusted before it is asked again.
 *
 * Short, because the dashboard is a service that can stop and start under us,
 * and the cost of being wrong is asymmetric in an unusual direction here: a
 * stale YES is harmless (the turn falls back to the CLI and the customer waits
 * the old amount), while a stale NO would keep a working box on the slow path
 * until the web server restarted. Half a minute keeps both short-lived.
 */
const PROBE_TTL_MS = 30_000;

let probe: { at: number; value: Promise<boolean> } | null = null;

/**
 * Can turns be streamed through the dashboard on THIS box, right now?
 *
 * Asked, not assumed, and asked by doing the first half of the real thing: mint
 * a WebSocket ticket. That single call proves the dashboard process is up, that
 * the stored password still opens it, and that the socket endpoints are enabled
 * — which is the whole precondition, and nothing weaker tests all three. The
 * ticket is then thrown away; it is single-use and expires in thirty seconds.
 *
 * Fails closed. A box that cannot answer is a box that spawns the CLI, which is
 * slower and completely correct.
 */
export async function hermesCanStreamTurns(): Promise<boolean> {
  const now = Date.now();
  if (probe && now - probe.at < PROBE_TTL_MS) return probe.value;
  const value = dashboardWsTicket()
    .then((ticket) => Boolean(ticket))
    .catch(() => false);
  probe = { at: now, value };
  return value;
}

/** Test seam: forget the probe so the next call asks again. */
export function resetHermesStreamProbe(): void {
  probe = null;
}

export interface DashboardTurnRequest {
  readonly text: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reasoning?: string;
  /** A stored session id to resume, or empty to start a new conversation. */
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

export interface DashboardTurnFinal {
  readonly text: string;
  readonly reasoning: string;
  /** The dashboard's own word for how the turn ended: `complete`, `error`, … */
  readonly status: string;
  readonly error?: string;
  /**
   * The model that ACTUALLY served this turn, as the dashboard reported it —
   * not the one the pills asked for. The two can differ (a refused switch), and
   * when they do the record has to say what really answered.
   */
  readonly model?: string;
  /** The provider behind `model`, when the dashboard names one. */
  readonly provider?: string;
}

export interface DashboardTurn {
  /**
   * The durable session id this turn runs against — the same
   * `YYYYMMDD_HHMMSS_hex` shape `chat -q --resume` takes and `readHermesTurn`
   * reads, so threading and the turn record are unchanged by the transport.
   */
  readonly sessionId: string;
  /**
   * The model this session is set to run when the turn is submitted, and the
   * provider behind it. Read from the dashboard rather than echoed back from
   * the request, so a switch that did not take is visible instead of assumed.
   */
  readonly model: string;
  readonly provider: string;
  /** Run the submitted turn, reporting each fragment of the answer as it lands. */
  run(onDelta: (chunk: string) => void): Promise<DashboardTurnFinal>;
  /** Drop the socket. Safe to call twice, and safe to call after `run` settles. */
  close(): void;
}

/** A frame off the socket, as far as we are willing to assume. */
interface GatewayFrame {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
  params?: { type?: unknown; payload?: unknown };
}

function parseFrame(raw: unknown): GatewayFrame | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as GatewayFrame) : null;
  } catch {
    return null;
  }
}

function frameType(frame: GatewayFrame): string {
  const type = frame.params?.type;
  return typeof type === "string" ? type : "";
}

/**
 * Did a `/model` switch actually take?
 *
 * It cannot be read from the JSON-RPC envelope alone, and assuming otherwise is
 * a bug this had. A REFUSED switch comes back as a perfectly successful reply:
 *
 *   { "output": "  ✗ Model `deepseek-v4-flash` was not found in this
 *                 provider's model listing.",
 *     "warning": "live session sync failed: …" }
 *
 * No `error` member anywhere. Treating that as success is what made the turn
 * report a model it was not running — the exact dishonesty the model field was
 * added to remove. Captured verbatim from the bench box.
 *
 * Read conservatively: a switch counts as made only when nothing says it was
 * not. `warning` is upstream's own channel for "the live session did not sync",
 * and `✗` is the marker its own output uses for a refusal.
 */
/**
 * Ids that are safe to place in a `/model …` command line.
 *
 * The switch is a COMMAND STRING the gateway parses into flags, so a value
 * carrying whitespace could add its own — and the flag it would reach for is
 * `--global`, the one that writes config.yaml and changes the model for every
 * other session, Telegram and cron. The chat route already charset-checks both
 * values (`isSafeHermesModelId`, `isPlausibleHermesProviderId`, neither of
 * which admits a space or a leading `-`), but this module is a library and must
 * not depend on its caller having done that: the whole point of `--session` is
 * that a chat turn cannot change the device default, and one unvalidated caller
 * would be enough to undo it.
 */
const COMMAND_SAFE_ID = /^[A-Za-z0-9_./:-]+$/;

function commandSafe(value: string): boolean {
  return !value.startsWith("-") && COMMAND_SAFE_ID.test(value);
}

function modelSwitchTook(frame: GatewayFrame): boolean {
  if (frame.error) return false;
  const result = frame.result || {};
  const warning = result.warning;
  if (typeof warning === "string" && warning.trim()) return false;
  const output = typeof result.output === "string" ? result.output : "";
  return !output.includes("✗");
}

function payloadText(frame: GatewayFrame): string {
  const payload = frame.params?.payload;
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

/**
 * Open a socket, settle the session, and hand back something that can run ONE turn.
 *
 * Connecting is separated from running on purpose. Everything that can fail for
 * an ordinary reason — the dashboard is down, the stored password is stale, the
 * session id no longer exists — fails HERE, in about a tenth of a second, while
 * the caller can still fall back to spawning the CLI. Once `run` starts, the
 * response has already been committed to streaming and there is no way back.
 *
 * Returns null rather than throwing for exactly that reason: "this box cannot
 * stream right now" is an expected answer, not a fault.
 */
export async function openDashboardTurn(req: DashboardTurnRequest): Promise<DashboardTurn | null> {
  if (req.signal?.aborted) return null;
  const ticket = await dashboardWsTicket(req.signal).catch(() => null);
  if (!ticket) return null;

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${DASHBOARD_WS_ORIGIN}/api/ws?ticket=${encodeURIComponent(ticket)}`, {
      // The dashboard binds a non-loopback address and refuses an upgrade whose
      // Host does not name it. `ws` sets that from the URL, so this only has to
      // not be overridden — but the origin guard is checked too, and an absent
      // Origin is what a non-browser client is expected to present.
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  const close = () => {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  };

  /** Frames that arrive before anyone is reading them, so none are lost. */
  const queue: GatewayFrame[] = [];
  let waiter: ((frame: GatewayFrame) => void) | null = null;
  let dead: Error | null = null;
  let deadWaiter: ((err: Error) => void) | null = null;

  const fail = (err: Error) => {
    if (!dead) dead = err;
    deadWaiter?.(dead);
  };

  socket.on("message", (raw) => {
    const frame = parseFrame(raw);
    if (!frame) return;
    if (waiter) {
      const resume = waiter;
      waiter = null;
      resume(frame);
    } else {
      queue.push(frame);
    }
  });
  socket.on("error", (err: Error) => fail(err));
  socket.on("close", (code: number) => fail(new Error(`dashboard socket closed (${code})`)));

  /** Next frame, or a rejection if the socket died or nothing came in time. */
  const nextFrame = (timeoutMs: number): Promise<GatewayFrame> =>
    new Promise<GatewayFrame>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) {
        resolve(queued);
        return;
      }
      if (dead) {
        reject(dead);
        return;
      }
      const timer = setTimeout(() => {
        waiter = null;
        deadWaiter = null;
        reject(new Error("dashboard stream went quiet"));
      }, timeoutMs);
      waiter = (frame) => {
        clearTimeout(timer);
        deadWaiter = null;
        resolve(frame);
      };
      deadWaiter = (err) => {
        clearTimeout(timer);
        waiter = null;
        reject(err);
      };
    });

  try {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("dashboard socket connect timed out")), CONNECT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Ask for the session, then read until its reply. The server opens with a
    // `gateway.ready` event and keeps emitting housekeeping events throughout,
    // so the reply is found by its id rather than by position.
    const wantResume = Boolean(req.sessionId);
    const rpcId = 1;
    let lastRpcId = rpcId;
    const nextRpcId = () => ++lastRpcId;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        method: wantResume ? "session.resume" : "session.create",
        params: wantResume
          ? {
              session_id: req.sessionId,
              // The transcript is ours: `/setup-api/chat/history` serves it from
              // our own store. Replaying the whole conversation over this socket
              // would be a large payload nothing reads.
              omit_messages: true,
              source: "clawbox-chat",
            }
          : {
              ...(req.model ? { model: req.model } : {}),
              ...(req.provider ? { provider: req.provider } : {}),
              ...(req.reasoning ? { reasoning_effort: req.reasoning } : {}),
              source: "clawbox-chat",
            },
      }),
    );

    /**
     * Read frames until the reply to `id` arrives, ignoring events on the way.
     *
     * The server opens with `gateway.ready` and keeps emitting housekeeping
     * events throughout, so a reply is found by its id rather than by position.
     */
    const awaitReply = async (id: number, timeoutMs: number): Promise<GatewayFrame> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Date.now() > deadline) throw new Error("dashboard reply timed out");
        const frame = await nextFrame(Math.max(1, deadline - Date.now()));
        if (frame.id === id) return frame;
      }
    };

    const sessionFrame = await awaitReply(rpcId, SESSION_TIMEOUT_MS);
    if (sessionFrame.error) {
      throw new Error(String(sessionFrame.error.message || "dashboard refused the session"));
    }
    const result = sessionFrame.result || {};
    const transportSid = typeof result.session_id === "string" ? result.session_id : "";
    const stored = result.stored_session_id;
    const sessionId = typeof stored === "string" && stored ? stored : req.sessionId || "";
    if (!transportSid) throw new Error("dashboard returned no session handle");

    // What this session is ACTUALLY set to run, as the dashboard reports it.
    // `session.resume` returns it in `info` ({model, provider, reasoning_effort,
    // …}); `session.create` returns the model there too. This is the only
    // trustworthy answer to "which model will the next turn use" — the pills in
    // our UI are a request, not a fact.
    const info = (result.info || {}) as Record<string, unknown>;
    let activeModel = typeof info.model === "string" ? info.model : "";
    let activeProvider = typeof info.provider === "string" ? info.provider : "";
    // On a FRESH session the override is part of the create call itself and is
    // honoured by contract (`session.create` builds the agent with it), so the
    // request is the truth here even if `info` was assembled before the build.
    if (!wantResume && req.model) {
      activeModel = req.model;
      if (req.provider) activeProvider = req.provider;
    }

    // ── Making a mid-conversation switch REAL ────────────────────────────
    //
    // `session.create` takes model/provider/reasoning_effort as per-session
    // overrides, so the FIRST turn of a chat already lands on the picked model.
    // `session.resume` takes none of them — it restores the session's stored
    // override and ignores anything else in params — so every LATER turn used
    // to run on whatever the conversation started with. Changing the pills
    // mid-chat therefore did nothing at all: a session opened on claude-fable-5
    // kept answering from claude-fable-5 after being switched to gpt-5.6-sol,
    // and said so when asked.
    //
    // Upstream's own answer to this is `/model <id> --provider <slug> --session`,
    // which is what the dashboard's Chat tab runs when its picker changes. It
    // swaps the live agent's client in place and pins the choice as a
    // PER-SESSION override; `resolve_persist_behavior` returns false for
    // `--session`, so config.yaml is never written and — upstream's own words —
    // the switch cannot leak "into every OTHER live session's next agent
    // rebuild". A chat turn must never change the box's default, and with this
    // flag it cannot.
    //
    // Skipped ONLY when the session is already provably on the requested model.
    // The switch costs ~3.3s on this hardware (it rebuilds the agent's client),
    // which is most of a fast turn, so re-asserting a model the session already
    // runs is worth avoiding — but silence is not proof: when the dashboard did
    // not say what the session is on, the turn is switched rather than assumed,
    // because assuming is precisely the bug this fixes.
    //
    // Compared on the MODEL id alone. `info.provider` reports a user-defined
    // provider by its KIND (`custom`) rather than its slug (`clawai`), so
    // comparing providers would report a difference on every single turn and
    // pay that cost forever.
    const alreadyOnModel = Boolean(activeModel) && activeModel === req.model;
    if (wantResume && req.model && !alreadyOnModel) {
      // An id that cannot go on a command line safely does not go on one. The
      // turn drops to the CLI instead, where the same values travel as separate
      // argv elements and cannot become flags.
      if (!commandSafe(req.model) || (req.provider && !commandSafe(req.provider))) {
        throw new Error("model or provider is not safe to switch with");
      }
      const switchId = nextRpcId();
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: switchId,
          method: "slash.exec",
          params: {
            session_id: transportSid,
            command: `/model ${req.model}${req.provider ? ` --provider ${req.provider}` : ""} --session`,
          },
        }),
      );
      const switched = await awaitReply(switchId, SWITCH_TIMEOUT_MS);
      // A switch that did not take gives this transport UP, rather than
      // answering on the wrong model.
      //
      // There is a real case for it, found on the box: switching TO a
      // user-defined provider is refused, because the switch validates the
      // model against the target provider's model listing and a
      // `providers.<slug>` entry in config.yaml carries none. On this device
      // that is `clawai` — the DEFAULT provider — so "go back to ClawBox AI
      // mid-conversation" is exactly the combination that cannot be made here.
      //
      // Throwing lands in the catch below, which returns null, and the route
      // then spawns the CLI for this turn. That path passes `-m` and
      // `--provider` as argv to a fresh process, with no session to re-point,
      // and is proven to run both of them correctly. The turn is slower and
      // not streamed, and it is ANSWERED BY THE MODEL THE CUSTOMER PICKED —
      // which is the property that matters more.
      if (!modelSwitchTook(switched)) {
        throw new Error(`dashboard would not switch this session to ${req.model}`);
      }
      activeModel = req.model;
      if (req.provider) activeProvider = req.provider;
    }

    let started = false;
    return {
      sessionId,
      model: activeModel,
      provider: activeProvider,
      close,
      async run(onDelta: (chunk: string) => void): Promise<DashboardTurnFinal> {
        if (started) throw new Error("this turn has already run");
        started = true;
        // Name the abort BEFORE closing. Closing alone made `run` reject with
        // `dashboard socket closed (<code>)`, which the route's `isAbort` check
        // cannot match — so a user pressing Stop was recorded in the customer's
        // transcript as a failed turn. `isAbort` tests for a real DOMException,
        // which is why this is not a plain Error with the name set.
        const onAbort = () => {
          fail(new DOMException("aborted", "AbortError") as unknown as Error);
          close();
        };
        req.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: nextRpcId(),
              method: "prompt.submit",
              params: { session_id: transportSid, text: req.text },
            }),
          );
          let answer = "";
          let reasoning = "";
          let truncated = false;
          for (;;) {
            const frame = await nextFrame(IDLE_TIMEOUT_MS);
            switch (frameType(frame)) {
              case EVENT.messageDelta: {
                const chunk = payloadText(frame);
                if (!chunk) break;
                if (answer.length + chunk.length > MAX_TEXT_BYTES) {
                  truncated = true;
                  break;
                }
                answer += chunk;
                onDelta(chunk);
                break;
              }
              case EVENT.reasoningDelta:
                // Collected, never forwarded. The bubble shows the answer; the
                // monologue belongs behind the reasoning disclosure, and the
                // authoritative copy is read from the agent's database at the end.
                if (reasoning.length < MAX_TEXT_BYTES) reasoning += payloadText(frame);
                break;
              case EVENT.thinkingDelta:
                // Dropped on purpose — see EVENT.thinkingDelta. This is the
                // spinner's status line, not the model's reasoning, and a turn
                // whose model reasons about nothing must end with NO reasoning
                // rather than a kaomoji. Still counts as activity: arriving here
                // has already restarted the idle clock.
                break;
              case EVENT.approvalRequest: {
                // Answer immediately. The agent thread is parked waiting for
                // this and will not make another model call until it lands.
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const requestId = payload.request_id;
                socket.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: nextRpcId(),
                    method: "approval.respond",
                    params: {
                      session_id: transportSid,
                      choice: APPROVAL_CHOICE,
                      ...(typeof requestId === "string" && requestId ? { request_id: requestId } : {}),
                    },
                  }),
                );
                break;
              }
              case EVENT.messageComplete: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const finalText = typeof payload.text === "string" ? payload.text : answer;
                const finalReasoning = typeof payload.reasoning === "string" ? payload.reasoning : reasoning;
                const status = typeof payload.status === "string" ? payload.status : "complete";
                const error = typeof payload.error === "string" ? payload.error : "";
                // The turn may name the model that served it; otherwise the one
                // this session was settled on above is the answer.
                const servedModel = typeof payload.model === "string" && payload.model ? payload.model : activeModel;
                const servedProvider =
                  typeof payload.provider === "string" && payload.provider ? payload.provider : activeProvider;
                return {
                  text: truncated ? `${finalText}\n\n[Reply truncated — it was too long to hold.]` : finalText,
                  reasoning: finalReasoning,
                  status,
                  ...(error ? { error } : {}),
                  ...(servedModel ? { model: servedModel } : {}),
                  ...(servedProvider ? { provider: servedProvider } : {}),
                };
              }
              case EVENT.error: {
                const payload = (frame.params?.payload || {}) as Record<string, unknown>;
                const message = typeof payload.message === "string" ? payload.message : "";
                throw new Error(message || "the agent reported an error");
              }
              default:
                // Every other frame is display detail this route does not
                // render (tool chips, usage, session info). Logged only when
                // asked, because the failure mode this exists for — the agent
                // parked on a prompt nobody answered — is invisible from the
                // outside and cost an afternoon to find once already.
                if (DEBUG_FRAMES) {
                  const type = frameType(frame);
                  if (type) console.log(`[hermes-stream] ${type}`);
                }
                break;
            }
          }
        } finally {
          req.signal?.removeEventListener("abort", onAbort);
          close();
        }
      },
    };
  } catch {
    close();
    return null;
  }
}
