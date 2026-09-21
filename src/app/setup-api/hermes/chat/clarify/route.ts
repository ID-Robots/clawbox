export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { WebSocket } from "ws";
import { DASHBOARD_WS_ORIGIN, dashboardWsTicket } from "@/lib/hermes-dashboard-auth";

// ── Answering the question the agent stopped to ask ────────────────────────
//
// A Hermes turn can park itself on a `clarify.request` — "which of these three
// files did you mean?" — and wait, on the agent's own worker thread, for
// `agent.clarify_timeout` seconds. That default is 3600, and a configured value
// of `<= 0` means forever. The chat stream carries the question out as a
// `clarify` event; this route carries the answer back.
//
// WHY IT IS ITS OWN ROUTE, ON ITS OWN SOCKET. `clarify.respond` takes
// `{ request_id, answer, question_id? }` and NO session id — upstream resolves
// the session from a global pending registry keyed by the request id
// (tui_gateway/server.py `_respond` :11898), which is exactly why the dashboard
// can be answered from its own SPA, from Telegram, or from here. The answer
// therefore does not have to travel back down the socket that asked, and
// deliberately does not:
//
//   * the SSE stream stays ONE-DIRECTIONAL. There is no upstream channel on a
//     server-sent-events response to smuggle a POST body into, and inventing
//     one (a second fetch that the streaming handler polls, a shared in-memory
//     registry of live turns) would put mutable per-request state in a route
//     that currently has none.
//   * and the property that actually matters: a prompt can be answered AFTER
//     the streaming request has died. That is not a corner case — it is the
//     case that produced the bug. The customer closes the tab, or the idle
//     watchdog gives up, or a proxy drops the response; the browser's turn is
//     over, and the agent is still parked on the question for the rest of the
//     hour, holding the session against every later turn. A short-lived socket
//     minted here does not care that the original one is gone.
//
// Session-gated by middleware, like every other /setup-api/* surface that is
// not on the small public list — same as the sibling `chat/history` route,
// which likewise carries no auth check of its own. Nothing here is reachable
// without the owner's session cookie, and the MCP bearer is not a person.

/** Bound on the handshake itself, which is local and answers in milliseconds. */
const CONNECT_TIMEOUT_MS = 8_000;

/** Bound on the gateway's acknowledgement, once the socket is up. */
const REPLY_TIMEOUT_MS = 10_000;

/**
 * Bound on the WHOLE call, connect and reply together.
 *
 * The per-step timeouts alone would let a dashboard that is slow at each step
 * in turn hold this request for their sum. A wedged agent must not be able to
 * hold a customer's POST open, so the deadline is taken once, up front, and
 * every step is given only what is left of it.
 */
const TOTAL_TIMEOUT_MS = 12_000;

/**
 * What a `request_id` may look like.
 *
 * Upstream mints it as `uuid4().hex[:8]` (server.py `_block` :3486), so eight
 * hex characters is the real shape; the check is kept a little wider than that
 * because the value is upstream's to change, and it is a bounded charset rather
 * than a length so a hostile body cannot arrive as a megabyte of text that gets
 * logged, echoed, or put on a URL.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Same reasoning for a batch's `question_id`, which is upstream's own qid. */
const QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The most answer text this route will forward.
 *
 * An answer is a person's reply to a question — a choice label, a filename, a
 * sentence. A multi-select answer is a JSON array of choice labels, which is
 * the widest legitimate case and still nowhere near this. The cap exists so
 * that a client cannot push an unbounded string through a WebSocket into an
 * agent's tool result.
 */
const MAX_ANSWER_CHARS = 4_000;

/** The dashboard is down, unreachable, or hung up. Reported as 503. */
class DashboardUnavailableError extends Error {}

/** The dashboard answered, and its answer was a refusal. Reported as 502. */
class DashboardRefusedError extends Error {}

interface GatewayReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: unknown };
}

function parseReply(raw: unknown): GatewayReply | null {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as GatewayReply) : null;
  } catch {
    return null;
  }
}

/** Milliseconds left of the overall deadline, never zero or negative. */
function remainingMs(deadline: number, cap: number): number {
  return Math.max(1, Math.min(cap, deadline - Date.now()));
}

/** The one RPC this socket exists to make. */
const RPC_ID = 1;

/**
 * How many questions of a batch are still unanswered, when the gateway says.
 *
 * Forwarded rather than computed, because only the gateway knows: the answers
 * accumulate in ITS registry, across every client that has answered anything,
 * and a browser that had half the form filled in has no way to know what
 * somebody else locked in from Telegram. Re-typed on the way through so the
 * shape the client receives is one this route has actually looked at.
 */
function remainingAnswer(result: Record<string, unknown>): number | string[] | null {
  const raw = result.remaining;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (Array.isArray(raw)) {
    const ids = raw.filter((value): value is string => typeof value === "string");
    return ids.length ? ids : null;
  }
  return null;
}

interface ClarifyAnswerResult {
  status: "ok" | "expired";
  remaining?: number | string[];
}

/**
 * Open a socket of our own, send the answer, wait for the acknowledgement, close.
 *
 * Every exit path closes the socket. A leaked connection here would be a leaked
 * authenticated session on a box whose whole security model is that the ticket
 * is single-use and short-lived.
 */
async function answerPendingClarify(
  requestId: string,
  answer: string,
  questionId: string,
): Promise<ClarifyAnswerResult> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const ticket = await dashboardWsTicket().catch(() => null);
  // No ticket means the dashboard is down, or the stored password no longer
  // opens it. Both are "come back later", not "your answer was wrong".
  if (!ticket) throw new DashboardUnavailableError("The Hermes dashboard is not answering right now.");

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${DASHBOARD_WS_ORIGIN}/api/ws?ticket=${encodeURIComponent(ticket)}`, {
      // Opened exactly the way `openDashboardTurn` opens its own: the dashboard
      // binds a non-loopback address and refuses an upgrade whose Host does not
      // name it, which `ws` sets from the URL, and an absent Origin is what a
      // non-browser client is expected to present.
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    throw new DashboardUnavailableError(err instanceof Error ? err.message : "Could not reach the Hermes dashboard.");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DashboardUnavailableError("The Hermes dashboard did not accept the connection in time.")),
        remainingMs(deadline, CONNECT_TIMEOUT_MS),
      );
      const settle = (err?: Error) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      if (socket.readyState === WebSocket.OPEN) {
        settle();
        return;
      }
      socket.once("open", () => settle());
      socket.once("error", (err: Error) => settle(new DashboardUnavailableError(err.message)));
      socket.once("close", (code: number) =>
        settle(new DashboardUnavailableError(`The Hermes dashboard closed the connection (${code}).`)),
      );
    });

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: RPC_ID,
        method: "clarify.respond",
        // `question_id` only when there is one. Against a BATCH an answer with
        // no question_id is upstream's cancel-all, so sending an empty string
        // would not be a harmless default — it would discard every other
        // question in the same prompt.
        params: {
          request_id: requestId,
          answer,
          ...(questionId ? { question_id: questionId } : {}),
        },
      }),
    );

    const reply = await new Promise<GatewayReply>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DashboardUnavailableError("The Hermes dashboard did not acknowledge the answer.")),
        remainingMs(deadline, REPLY_TIMEOUT_MS),
      );
      const settle = (value: GatewayReply | null, err?: Error) => {
        clearTimeout(timer);
        if (err) reject(err);
        else if (value) resolve(value);
      };
      // Found by its id, not by position: the gateway keeps emitting its own
      // events on this socket from the moment it is opened.
      socket.on("message", (raw: unknown) => {
        const frame = parseReply(raw);
        if (frame && frame.id === RPC_ID) settle(frame);
      });
      socket.once("error", (err: Error) => settle(null, new DashboardUnavailableError(err.message)));
      socket.once("close", (code: number) =>
        settle(null, new DashboardUnavailableError(`The Hermes dashboard closed the connection (${code}).`)),
      );
    });

    if (reply.error) {
      throw new DashboardRefusedError(String(reply.error.message || "Hermes would not take that answer."));
    }
    const result = reply.result || {};
    // `expired` is a SUCCESSFUL call whose window had closed. Upstream calls
    // `_respond` with `allow_expired=True` precisely so a late answer is
    // reported rather than raised, and a customer who was a few seconds slow
    // deserves "that question timed out" and not an error page.
    const status = result.status === "expired" ? "expired" : "ok";
    const remaining = remainingAnswer(result);
    return { status, ...(remaining !== null ? { remaining } : {}) };
  } finally {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }
}

// POST /setup-api/hermes/chat/clarify → { status: "ok" | "expired", remaining? }
//
// Body: { requestId, answer, questionId? }
export async function POST(request: Request) {
  let body: { requestId?: unknown; answer?: unknown; questionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId || !REQUEST_ID_RE.test(requestId)) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }

  // NOT trimmed, and not rejected when empty. An empty answer is a real answer
  // to hermes — a LOCKED SKIP that counts the question as done and releases the
  // batch — so "skip this one" and "you forgot to type something" are different
  // requests, and only the client knows which one it is making. Trimming would
  // also quietly rewrite an answer whose leading space the customer meant.
  if (typeof body.answer !== "string") {
    return NextResponse.json({ error: "answer must be text" }, { status: 400 });
  }
  const answer = body.answer;
  if (answer.length > MAX_ANSWER_CHARS) {
    return NextResponse.json(
      { error: `That answer is too long — keep it under ${MAX_ANSWER_CHARS} characters.` },
      { status: 400 },
    );
  }

  const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
  if (body.questionId !== undefined && (typeof body.questionId !== "string" || !QUESTION_ID_RE.test(questionId))) {
    return NextResponse.json({ error: "Invalid questionId" }, { status: 400 });
  }

  try {
    return NextResponse.json(await answerPendingClarify(requestId, answer, questionId));
  } catch (err) {
    if (err instanceof DashboardRefusedError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    if (err instanceof DashboardUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // Anything else is this route being wrong rather than the box being down,
    // and is reported as such instead of being dressed up as a dead dashboard.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not deliver that answer." },
      { status: 500 },
    );
  }
}
