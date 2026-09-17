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
