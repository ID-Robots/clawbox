/**
 * The OpenClaw gateway's own RPC, spoken in-process.
 *
 * WHY THIS EXISTS. Every gateway call this server made went through
 * `openclaw gateway call …` — a full CLI start-up (the bundle loads the SDK,
 * parses plugins, validates config) that costs ~3 s on a Jetson to deliver a
 * request the gateway answers in 80 ms. A chat model switch made three of
 * them and took ten seconds. The gateway is a WebSocket server on loopback
 * with a documented handshake (`docs/gateway/protocol/handshake.md` in the
 * core: a `connect.challenge` event, a `connect` request carrying the shared
 * token, `hello-ok`, then `req`/`res` frames), and this server already holds
 * that token for the browser's chat. Speaking it directly is the native
 * mechanism without the process the CLI wraps around it: ~20 ms to connect,
 * milliseconds per call.
 *
 * WHAT IT DOES NOT CHANGE. Callers still get the gateway's payload, and a
 * gateway that is down still fails — {@link GatewayWsUnavailableError} — so
 * `callGatewayRpc` falls back to the CLI, which answers with its own words
 * for that case. One socket per call: the gateway's per-connection state is
 * nothing this server wants to keep, and the 20 ms is not worth a pool.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import { WebSocket } from "ws";
import { envPort } from "@/lib/port-probe";

// Same default as `openclaw-config.ts` and `gateway-proxy.ts`; read here rather
// than imported so this module sits BELOW `openclaw-config.ts`, which calls it.
const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);

/** The gateway is not there to talk to: connect refused, timed out, or the
 *  handshake itself failed. The CLI path is the answer for these. */
export class GatewayWsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayWsUnavailableError";
  }
}

/** The gateway answered the call with `ok: false`. */
export class GatewayRpcError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
  }
}

const CONNECT_TIMEOUT_MS = 1_500;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const PROTOCOL = 4;
/** What the gateway's connect schema accepts for a local operator: the CLI's
 *  own identity (`client.id` and `client.mode` are enumerated server-side;
 *  "cli"/"cli" is the pair that passes with the shared token, verified on a
 *  box against core 2026.9.3). */
const CLIENT = { id: "cli", version: "clawbox", platform: "linux", mode: "cli" } as const;
const SCOPES = ["operator.read", "operator.write", "operator.admin"] as const;

interface Frame {
  type?: string;
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

export interface GatewayWsCallOptions {
  timeoutMs?: number;
}

/**
 * One request to the gateway over its WebSocket. Resolves with the response
 * payload (the object the CLI would have printed for `gateway call --json`).
 */
export async function gatewayWsCall(
  method: string,
  params: Record<string, unknown>,
  options: GatewayWsCallOptions = {},
): Promise<Record<string, unknown>> {
  return callAfterHello(method, () => params, options);
}

/**
 * The session the ClawBox web chat binds to: the hello snapshot's main session
 * key, falling back to `main` — read exactly the way ChatApp reads it on
 * connect, so a message posted here lands in the conversation the owner has
 * open rather than in one the server picked.
 */
export function mainSessionKeyOf(hello: Record<string, unknown>): string {
  const snapshot = hello.snapshot as Record<string, unknown> | undefined;
  const defaults = snapshot?.sessionDefaults as Record<string, unknown> | undefined;
  const key = defaults?.mainSessionKey;
  return typeof key === "string" && key.trim() ? key : "main";
}

/**
 * Post a user turn into the main chat session — the one the web chat is bound
 * to — and answer the key it went to. The gateway acknowledges the turn and
 * the agent answers it on the event stream, where the chat shows it; `deliver:
 * false`, as the chat's own sends are, so the reply is not pushed out to a
 * channel as well.
 *
 * One connection: the key comes from THIS handshake, so the turn cannot land in
 * a session some earlier hello named. Rejects {@link GatewayWsUnavailableError}
 * when there is no gateway to post to (no token, not listening, still booting)
 * and {@link GatewayRpcError} when the gateway refused the turn.
 */
export async function gatewayWsChatSendMain(
  message: string,
  options: GatewayWsCallOptions & { idempotencyKey: string },
): Promise<{ sessionKey: string }> {
  let sessionKey = "";
  await callAfterHello(
    "chat.send",
    (hello) => {
      sessionKey = mainSessionKeyOf(hello);
      return { sessionKey, message, deliver: false, idempotencyKey: options.idempotencyKey };
    },
    options,
  );
  return { sessionKey };
}

/**
 * The exchange itself: connect, handshake, then ONE request whose params may
 * depend on what the gateway said in its hello (`chat.send` needs the session
 * key the hello names).
 */
async function callAfterHello(
  method: string,
  paramsFor: (hello: Record<string, unknown>) => Record<string, unknown>,
  options: GatewayWsCallOptions,
): Promise<Record<string, unknown>> {
  // Loaded here, not at the top: `gateway-proxy` pulls the config store and
  // the session module in behind it, and `openclaw-config` (which calls this)
  // is imported by half the codebase — suites that mock the store would
  // otherwise pay for imports they never asked for.
  const { getGatewayToken } = await import("@/lib/gateway-proxy");
  const token = await getGatewayToken();
  if (!token) throw new GatewayWsUnavailableError("no gateway token");
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}`);
    const connectId = `c-${crypto.randomBytes(6).toString("hex")}`;
    const requestId = `r-${crypto.randomBytes(6).toString("hex")}`;
    let settled = false;
    let stage: "connect" | "handshake" | "call" = "connect";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    // Two deadlines: a short one to reach hello-ok (a gateway that is down
    // refuses at once; one that is booting answers nothing), then the call's.
    timer = setTimeout(() => {
      finish(() => reject(new GatewayWsUnavailableError(`gateway ${stage} timed out`)));
    }, CONNECT_TIMEOUT_MS);

    const send = (frame: Record<string, unknown>) => ws.send(JSON.stringify(frame));
    const connect = () => {
      stage = "handshake";
      send({
        type: "req",
        id: connectId,
        method: "connect",
        params: {
          minProtocol: PROTOCOL,
          maxProtocol: PROTOCOL,
          client: CLIENT,
          role: "operator",
          scopes: [...SCOPES],
          caps: [],
          commands: [],
          permissions: {},
          auth: { token },
          locale: "en-US",
          userAgent: "clawbox-web",
        },
      });
    };

    ws.on("error", (err: Error) => finish(() => reject(new GatewayWsUnavailableError(err.message))));
    ws.on("close", () => finish(() => reject(new GatewayWsUnavailableError(`gateway closed during ${stage}`))));
    ws.on("message", (raw: Buffer | string) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        return;
      }
      if (frame.type === "event" && frame.event === "connect.challenge" && stage === "connect") {
        connect();
        return;
      }
      if (frame.type !== "res") return;
      if (frame.id === connectId) {
        if (!frame.ok) {
          finish(() => reject(new GatewayWsUnavailableError(frame.error?.message ?? "connect refused")));
          return;
        }
        stage = "call";
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`))), timeoutMs);
        const hello = frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
          ? (frame.payload as Record<string, unknown>)
          : {};
        let params: Record<string, unknown>;
        try {
          params = paramsFor(hello);
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        send({ type: "req", id: requestId, method, params });
        return;
      }
      if (frame.id === requestId) {
        if (frame.ok === false) {
          finish(() => reject(new GatewayRpcError(frame.error?.message ?? `${method} failed`, frame.error?.code ?? "ERROR")));
          return;
        }
        const payload = frame.payload;
        finish(() => resolve(payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {}));
      }
    });
    // A gateway older than the challenge would never send one; the docs allow
    // connecting on open in that case. Ours sends it within a millisecond, so
    // a short grace covers both.
    ws.on("open", () => {
      setTimeout(() => {
        if (stage === "connect" && !settled) connect();
      }, 250).unref?.();
    });
  });
}

/**
 * Write config through the gateway: `config.get` for the current file hash,
 * then `config.patch` with the merge. The gateway validates, writes the file
 * and hot-applies what it can — the same write `openclaw config set` makes,
 * minus the process. Answers what changed; `noop` when nothing did.
 */
export async function gatewayWsPatchConfig(
  patch: Record<string, unknown>,
  options: GatewayWsCallOptions & { replacePaths?: string[] } = {},
): Promise<{ noop: boolean; changedPaths: string[] }> {
  const current = await gatewayWsCall("config.get", {}, options);
  const baseHash = current.hash;
  if (typeof baseHash !== "string" || !baseHash) throw new GatewayRpcError("config.get returned no hash", "NO_HASH");
  const result = await gatewayWsCall(
    "config.patch",
    {
      baseHash,
      raw: JSON.stringify(patch),
      ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
    },
    options,
  );
  const changed = Array.isArray(result.changedPaths) ? result.changedPaths.filter((p): p is string => typeof p === "string") : [];
  return { noop: result.noop === true, changedPaths: changed };
}

/**
 * The gateway's OWN readiness contract, on its own HTTP port. `/startupz`
 * answers 200 `{ok:true,status:"started"}` once the gateway has finished
 * starting and 503 `{ok:false,status:"starting",pendingReason}` until then
 * (`gateway-http-route-contracts.ts`, `server-http-probes.ts` in the pinned
 * core), and the aggregate boolean needs no auth. The core polls exactly this
 * surface for the same question — `waitForGatewayHttpReadiness` in
 * `cli/daemon-cli/restart-health-probe.ts`, behind `openclaw update`'s own
 * verification — which is why this waits on it rather than on an answer of
 * ClawBox's own invention.
 *
 * `/startupz` and not `/readyz`, deliberately: readiness folds in CHANNEL
 * health, so a box whose Telegram channel is down answers 503 there for as
 * long as it is down, and a wait for the gateway to accept an RPC would spend
 * its whole budget over a gateway perfectly able to answer one. The startup
 * probe is the exact gate — the connect admission refuses with "gateway
 * starting; retry shortly" on `isStartupPending()`, the same state
 * `createStartupChecker` reports here.
 */
const STARTUP_PROBE_PATH = "/startupz";
/** One probe. Loopback and answered off a state flag; anything slower is a
 *  gateway that is not answering yet, which is what the poll is for. */
const STARTUP_PROBE_TIMEOUT_MS = 2_000;
const STARTUP_POLL_INTERVAL_MS = 500;

async function gatewayHasStarted(timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${STARTUP_PROBE_PATH}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Consumed although nothing here reads it: undici holds the socket open
    // until the body is, and this is a poll rather than a single request.
    await res.text().catch(() => "");
    return res.status === 200;
  } catch {
    // Nothing listening yet, or the probe outlived its own deadline. Both are
    // "not started", and neither is a fact the caller can act on separately.
    return false;
  }
}

/**
 * Wait until the gateway ANSWERS a request, not merely listens: for ten to
 * twenty seconds after its port opens it refuses every connect with "gateway
 * starting; retry shortly", and a write made in that window is lost with the
 * refusal.
 *
 * The BUDGET is the caller's, with no default — this module cannot choose one
 * for a device it knows nothing about, and the one budget ClawBox has for
 * "how long may a gateway take to come back" is `gatewayReadyWaitMs()`, which
 * lives above this module (and carries the `GATEWAY_READY_WAIT_MS` escape
 * hatch). A hardcoded 60 s here was twice that budget with no way to change
 * it, on a request a person is watching through a tunnel that gives up at 100.
 *
 * Answers false rather than throwing: the caller decides what a gateway that
 * has not come back yet means for its own answer. No token is read anywhere on
 * this path — the probe is unauthenticated, so a box whose shared token this
 * server cannot use (a `${ENV}` interpolation, a SecretRef, an unreadable
 * openclaw.json) is waited for like any other rather than reported as one that
 * will never answer.
 */
export async function waitForGatewayRpcReady(budgetMs: number, intervalMs = STARTUP_POLL_INTERVAL_MS): Promise<boolean> {
  // A malformed budget must not become an unbounded hot spin — `waitForPortOpen`
  // guards its own the same way. Zero means "one probe, then give up".
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  const deadline = Date.now() + budget;
  for (;;) {
    // ONE probe may not outlive the WHOLE wait, and a spent budget still asks
    // once, at full length: "give up at once" must not become "never ask".
    const left = deadline - Date.now();
    const probeMs = left > 0 ? Math.min(STARTUP_PROBE_TIMEOUT_MS, left) : STARTUP_PROBE_TIMEOUT_MS;
    if (await gatewayHasStarted(probeMs)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
