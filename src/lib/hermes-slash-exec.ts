import { WebSocket } from "ws";
import { DASHBOARD_WS_ORIGIN, dashboardWsTicket } from "@/lib/hermes-dashboard-auth";

/**
 * Run ONE Hermes slash command and hand back what it printed.
 *
 * Hermes executes a slash command through its own RPCs and NOT through
 * `prompt.submit` — that one hands the text to the model as a prompt, so a box
 * asked `/status` down the ordinary turn path answers with the model's opinion
 * of the word "/status" instead of the session's status. `slash.exec` is the
 * door, and it is the same one `hermes-dashboard-turn.ts` already uses for the
 * internal `/model … --session` switch, so the mechanism is not new here; what
 * is new is that a command the OWNER typed can reach it.
 *
 * Two RPCs on one socket, because `slash.exec` is session-scoped and the
 * gateway's sessions live in memory: `_sess_nowait` answers `4001 session not
 * found` for an id it is not currently holding, and tells the client to resume
 * the stored id — so the session is established first, exactly as the dashboard's
 * own client does. `dashboardRpc` cannot be reused for this: it is one call per
 * socket by design.
 *
 * Nothing here decides what a command means or which commands exist. The
 * routing between `slash.exec` and `command.dispatch` is HERMES' — `slash.exec`
 * forwards pending-input built-ins and bundles itself, and answers the one case
 * it will not run (a profile skill command) with an error that names
 * `command.dispatch` as the way to run it. This follows that instruction rather
 * than pre-judging which commands are which, so a Hermes that changes the split
 * keeps working.
 */

/** Bound on the upgrade. Local socket; the same number `dashboardRpc` uses. */
const CONNECT_TIMEOUT_MS = 8_000;
/** Bound on establishing the session — a `session.create` builds an agent. */
const SESSION_TIMEOUT_MS = 30_000;
/**
 * Bound on the command itself.
 *
 * Generous because a slash command is not always cheap — `/compress` walks the
 * whole context, `/tools` enumerates a live MCP fleet — and because the owner
 * is watching a chat bubble, where "it is still going" is a better answer than
 * a timeout over a command that was going to succeed.
 */
const COMMAND_TIMEOUT_MS = 120_000;

/** Hermes' own hint that a command has to go through `command.dispatch`. */
const DISPATCH_HINT = /use command\.dispatch/i;

/** How this surface names itself in Hermes' own session records. */
const SOURCE = "clawbox-chat";

export interface HermesSlashResult {
  /** What the command printed, as Hermes worded it. Never empty. */
  readonly output: string;
  /**
   * The STORED session key the command ran against — `YYYYMMDD_HHMMSS_xxxxxx`,
   * the shape the chat route validates and the next turn resumes.
   *
   * Deliberately NOT the runtime handle. `session.create` and `session.resume`
   * answer with BOTH: `session_id` is an in-memory handle (`uuid4().hex[:8]`)
   * that only this socket's session-scoped RPCs take, and `stored_session_id`
   * is the durable key a client threads. Handing the first one back as the
   * conversation's id made the route's own `SESSION_ID_RE` reject it, so every
   * message AFTER a slash command answered HTTP 400 until the tab was reset.
   * `hermes-dashboard-turn.ts` keeps the two apart for the same reason.
   */
  readonly sessionId: string;
}

export interface HermesSlashRequest {
  /** The command as the owner typed it, leading slash included. */
  readonly command: string;
  /** A stored session id to resume, or empty to start a conversation. */
  readonly sessionId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly signal?: AbortSignal;
}

interface RpcFrame {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: unknown; code?: unknown };
}

/**
 * We stopped waiting — as opposed to `null`, which is "the socket never carried
 * it".
 *
 * The two must not be collapsed, because they mean opposite things to the
 * caller: a command the socket never carried may be retried down another path,
 * while one we merely stopped waiting for IS RUNNING on the box, and sending it
 * again — which for the chat route means submitting it to the MODEL — is the
 * run-twice failure this module exists to prevent. `/compress` on a long
 * conversation is the real case.
 */
const TIMED_OUT = Symbol("timed-out");
type CallResult = RpcFrame | null | typeof TIMED_OUT;

function parseFrame(raw: unknown): RpcFrame | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as RpcFrame) : null;
  } catch {
    return null;
  }
}

function errorText(frame: RpcFrame): string {
  return typeof frame.error?.message === "string" ? frame.error.message : "";
}

/**
 * Hermes' own word for a command that ran and printed nothing.
 *
 * Not ClawBox's invention: `slash.exec` and `command.dispatch` both substitute
 * this literal for an empty result (`worker.run(cmd) or "(no output)"`), so a
 * reply that says it is the harness's own convention being echoed where the
 * harness happened not to fill it in.
 */
const NO_OUTPUT = "(no output)";

/**
 * What the owner is told when a command outlived the deadline.
 *
 * ClawBox's own sentence, and the one string in this module that is: the
 * harness has said nothing yet, by definition. English like the rest of
 * `chat-error-text.ts`. It exists because the alternative — reporting the
 * transport as unavailable — makes the caller run the command a second time at
 * the model while the first one is still working.
 */
const STILL_RUNNING =
  "That command is still running on the box. Its result will not appear here — check back in the chat, or run it again once it has finished.";

/**
 * The text a command produced, whatever shape the result came in.
 *
 * `slash.exec`'s own worker answers `{ output }`, and so does a plugin command.
 * `command.dispatch` does NOT always: its stages answer `{type:"alias",target}`,
 * `{type:"send",message,notice}` and `{type:"plugin",output}` among others
 * (`tui_gateway/methods_tools.py`), and `slash.exec` forwards every
 * pending-input built-in — `/undo`, `/queue`, `/steer`, `/plan`, `/goal`,
 * `/compress` and the rest — straight to it. Reading `output` alone therefore
 * came back empty for a whole class of commands Hermes publishes and offers.
 */
function readOutput(result: Record<string, unknown> | undefined): string {
  for (const key of ["output", "message", "notice", "target"] as const) {
    const value = result?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Run `req.command`, or null when the dashboard could not be reached at all.
 *
 * Null means "this transport is not available" and nothing else — the caller
 * falls back to its own path. A command that RAN and failed is not null: its
 * failure is output, and the owner needs to read it.
 */
export async function runHermesSlashCommand(
  req: HermesSlashRequest,
): Promise<HermesSlashResult | null> {
  const command = req.command.trim();
  if (!command.startsWith("/") || command.length < 2) return null;

  const ticket = await dashboardWsTicket().catch(() => null);
  if (!ticket) return null;

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${DASHBOARD_WS_ORIGIN}/api/ws?ticket=${encodeURIComponent(ticket)}`, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  let nextId = 1;
  const pending = new Map<number, (frame: RpcFrame | null) => void>();
  let dead = false;
  const killAll = () => {
    if (dead) return;
    dead = true;
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };

  socket.on("message", (raw: unknown) => {
    const frame = parseFrame(raw);
    if (!frame || typeof frame.id !== "number") return;
    const resolve = pending.get(frame.id);
    if (!resolve) return;
    pending.delete(frame.id);
    resolve(frame);
  });
  socket.on("error", killAll);
  socket.on("close", killAll);

  /** One request. Null for a dead socket, TIMED_OUT when we stopped waiting. */
  const call = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CallResult> =>
    new Promise((resolve) => {
      if (dead || socket.readyState !== socket.OPEN) {
        resolve(null);
        return;
      }
      const id = nextId++;
      let settled = false;
      const finish = (frame: CallResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        resolve(frame);
      };
      const timer = setTimeout(() => finish(TIMED_OUT), timeoutMs);
      pending.set(id, finish);
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        finish(null);
      }
    });

  const abort = () => {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  };
  req.signal?.addEventListener("abort", abort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === socket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("handshake timeout")), CONNECT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("socket error"));
      });
    });

    // Resume the stored id when there is one, exactly as the gateway's own
    // rejection message tells a client to: an id it is no longer holding is a
    // 4001 on every session-scoped RPC until something resumes it.
    const wantResume = Boolean(req.sessionId);
    const sessionFrame = await call(
      wantResume ? "session.resume" : "session.create",
      wantResume
        ? {
            session_id: req.sessionId,
            // The same two the dashboard-turn sibling sends, and for its
            // reasons: `omit_messages` is not cosmetic — it selects Hermes'
            // tip-only load path, so without it a long conversation is read and
            // serialised over this socket for a payload nothing here reads, and
            // on a loaded box that can outlast the deadline below and drop the
            // command back to the model.
            omit_messages: true,
            source: SOURCE,
          }
        : {
            // `session.create` takes the pairing as per-session options; a
            // command still needs an agent behind it, and one built on the
            // box's default pairing is the same agent the next turn would get.
            ...(req.model ? { model: req.model } : {}),
            ...(req.provider ? { provider: req.provider } : {}),
            // Without it Hermes files the session as `tui`/`desktop` in its own
            // database — a conversation this surface started, recorded as
            // somebody else's.
            source: SOURCE,
          },
      SESSION_TIMEOUT_MS,
    );
    const result = sessionFrame && sessionFrame !== TIMED_OUT ? sessionFrame.result : undefined;
    // The handle this socket's session-scoped RPCs take…
    const transportSid = typeof result?.session_id === "string" ? result.session_id : "";
    // …and the durable key the CONVERSATION is threaded by. See the note on
    // `HermesSlashResult.sessionId`: these are two different values and the
    // route validates the second one.
    const stored = result?.stored_session_id;
    const sessionId = typeof stored === "string" && stored ? stored : req.sessionId || "";
    if (!transportSid || !sessionId) return null;

    let frame = await call(
      "slash.exec",
      { session_id: transportSid, command },
      COMMAND_TIMEOUT_MS,
    );
    // Hermes' own instruction, followed rather than second-guessed.
    if (frame && frame !== TIMED_OUT && frame.error && DISPATCH_HINT.test(errorText(frame))) {
      // Split ONCE, the way Hermes splits it (`cmd.lstrip("/").split(maxsplit=1)`),
      // so the argument reaches `command.dispatch` byte for byte. Splitting on
      // every run of whitespace and re-joining with single spaces re-worded a
      // multi-line or multi-space argument — `/goal draft …` — on the retry
      // path only, which is the worst kind of difference to have.
      const body = command.slice(1);
      const cut = body.search(/\s/);
      frame = await call(
        "command.dispatch",
        {
          session_id: transportSid,
          name: cut < 0 ? body : body.slice(0, cut),
          arg: cut < 0 ? "" : body.slice(cut + 1),
        },
        COMMAND_TIMEOUT_MS,
      );
    }
    // We stopped waiting — the command is RUNNING on the box. Answering null
    // here would send the caller down its fall-through, which for the chat
    // route means submitting the same command to the MODEL while the real one
    // is still going: a false failure over an operation that succeeded, and the
    // command run twice. So it comes back as a reply instead.
    if (frame === TIMED_OUT) {
      return { output: STILL_RUNNING, sessionId };
    }
    // No frame at all is the ONLY thing that means "this transport did not
    // carry the command" past this point. Everything below RAN.
    if (!frame) return null;
    if (frame.error) {
      // A command that ran and was refused. The refusal is the answer, worded
      // by the harness, and it is returned rather than thrown so the chat
      // renders it as a reply instead of a red banner over a working box.
      return { output: errorText(frame) || NO_OUTPUT, sessionId };
    }
    // Never null from here, whatever the result looked like. Answering null
    // over a command the gateway has already executed is not a fall-back, it is
    // the command being RUN TWICE — once as itself, and then again as a prompt
    // to the model by the caller's own fall-through. That is what reading
    // `output` alone used to do to every `command.dispatch` shape.
    return { output: readOutput(frame.result) || NO_OUTPUT, sessionId };
  } catch {
    return null;
  } finally {
    req.signal?.removeEventListener("abort", abort);
    killAll();
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }
}
