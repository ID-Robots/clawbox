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
}

export interface DashboardTurn {
  /**
   * The durable session id this turn runs against — the same
   * `YYYYMMDD_HHMMSS_hex` shape `chat -q --resume` takes and `readHermesTurn`
   * reads, so threading and the turn record are unchanged by the transport.
   */
  readonly sessionId: string;
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

    let sessionId = "";
    let transportSid = "";
    const sessionDeadline = Date.now() + SESSION_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > sessionDeadline) throw new Error("dashboard session setup timed out");
      const frame = await nextFrame(Math.max(1, sessionDeadline - Date.now()));
      if (frame.id !== rpcId) continue;
      if (frame.error) throw new Error(String(frame.error.message || "dashboard refused the session"));
      const result = frame.result || {};
      transportSid = typeof result.session_id === "string" ? result.session_id : "";
      const stored = result.stored_session_id;
      sessionId = typeof stored === "string" && stored ? stored : req.sessionId || "";
      break;
    }
    if (!transportSid) throw new Error("dashboard returned no session handle");

    let started = false;
    return {
      sessionId,
      close,
      async run(onDelta: (chunk: string) => void): Promise<DashboardTurnFinal> {
        if (started) throw new Error("this turn has already run");
        started = true;
        const onAbort = () => close();
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
              case EVENT.thinkingDelta:
                // Collected, never forwarded. The bubble shows the answer; the
                // monologue belongs behind the reasoning disclosure, and the
                // authoritative copy is read from the agent's database at the end.
                if (reasoning.length < MAX_TEXT_BYTES) reasoning += payloadText(frame);
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
                return {
                  text: truncated ? `${finalText}\n\n[Reply truncated — it was too long to hold.]` : finalText,
                  reasoning: finalReasoning,
                  status,
                  ...(error ? { error } : {}),
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
