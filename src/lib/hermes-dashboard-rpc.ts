import { WebSocket } from "ws";
import { DASHBOARD_WS_ORIGIN, dashboardWsTicket } from "@/lib/hermes-dashboard-auth";

/**
 * ONE JSON-RPC call to the Hermes dashboard's socket, for callers that want an
 * answer rather than a conversation.
 *
 * `hermes-dashboard-turn.ts` opens the same socket and drives a whole streaming
 * turn across it — a session to settle, deltas to forward, an approval prompt
 * that will hang the agent if nobody answers it. Almost none of that applies to
 * a call like `reload.mcp`: send one frame, read one reply, hang up. This module
 * is that shape, and it deliberately reuses the turn module's idiom for the part
 * that IS the same — mint a single-use ticket, dial `DASHBOARD_WS_ORIGIN`,
 * `await` the `open` event because `ws` comes up asynchronously, then read
 * frames until one carries our request id (the dashboard opens with
 * `gateway.ready` and keeps emitting housekeeping events throughout, so a reply
 * is found by id and never by position).
 *
 * IT NEVER THROWS. Every caller so far is a side effect on a path the owner is
 * already waiting on — a settings save — and a box with no dashboard at all is a
 * perfectly ordinary box: the OpenClaw edition ships without one. "The dashboard
 * did not answer" is an expected answer here, not a fault, so it comes back as
 * `null` and the caller carries on.
 */

/**
 * Bound on the upgrade itself. Local, and it answers in milliseconds — the same
 * number `hermes-dashboard-turn.ts` uses against the same endpoint.
 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Bound on the whole call, handshake included.
 *
 * Sized for the heaviest thing this is used for rather than the average one:
 * `reload.mcp` runs `shutdown_mcp_servers()` + `discover_mcp_tools()`, which
 * KILLS every MCP child process and spawns them again, and each one then has to
 * complete an initialize handshake and list its tools before the reply comes
 * back. ClawBox's own server alone probes binaries, the journal and
 * `/setup-api/email/status` while it boots (mcp/lib/context.ts). Seconds, not
 * milliseconds — so a bound in the low seconds would report failure on a box
 * that was working, and start a pointless retry.
 *
 * It is still a bound, because the failure this exists to survive is not a slow
 * reload but a dashboard that accepts the socket and then says nothing at all.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** The only id this module ever sends. One call, one socket, one reply. */
const REQUEST_ID = 1;

/** A frame off the socket, as far as we are willing to assume. */
interface RpcFrame {
  id?: number;
  result?: unknown;
  error?: { message?: unknown };
}

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

export interface DashboardRpcOptions {
  /** Bound on the whole call. Defaults to DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * Call `method` on the dashboard and hand back its `result`, or null.
 *
 * Null means "no answer to act on", and it deliberately does not distinguish
 * between the ways that happens: no dashboard, no ticket, a socket that died, a
 * reply that never came, or an error frame. A caller that cannot fix any of
 * those does not benefit from telling them apart, and every caller so far is in
 * exactly that position.
 */
export async function dashboardRpc(
  method: string,
  params: Record<string, unknown>,
  opts: DashboardRpcOptions = {},
): Promise<unknown | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Minting a ticket is also the probe: it proves the dashboard process is up,
  // that the stored password still opens it, and that the socket endpoints are
  // enabled. Nothing weaker tests all three, and on an edition with no
  // dashboard it is the call that fails first and cheapest.
  const ticket = await dashboardWsTicket().catch(() => null);
  if (!ticket) return null;

  let socket: WebSocket;
  try {
    socket = new WebSocket(`${DASHBOARD_WS_ORIGIN}/api/ws?ticket=${encodeURIComponent(ticket)}`, {
      handshakeTimeout: Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now())),
    });
  } catch {
    return null;
  }

  try {
    return await new Promise<unknown | null>((resolve) => {
      let settled = false;
      const finish = (value: unknown | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // The one deadline that covers everything after the ticket: a handshake
      // that never completes, a reply that never arrives, and the gap between.
      const timer = setTimeout(() => finish(null), Math.max(1, deadline - Date.now()));

      socket.on("error", () => finish(null));
      // Closing is how this call ENDS in the happy path too — see the `finally`
      // below — so the guard above is what keeps the answer we already have.
      socket.on("close", () => finish(null));
      socket.on("message", (raw: unknown) => {
        const frame = parseFrame(raw);
        // Events and other callers' replies are not this call's answer.
        if (!frame || frame.id !== REQUEST_ID) return;
        finish(frame.error ? null : (frame.result ?? null));
      });

      const send = () => {
        try {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: REQUEST_ID, method, params }));
        } catch {
          finish(null);
        }
      };
      // `ws` comes up asynchronously, but a socket handed to us already open
      // would never emit `open` again and the call would sit here until the
      // deadline.
      if (socket.readyState === WebSocket.OPEN) send();
      else socket.once("open", send);
    });
  } finally {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }
}
