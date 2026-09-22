import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The gateway's RPC spoken in-process. A fake gateway stands in: it sends the
 * connect challenge, checks the shared token, answers `hello-ok`, then
 * answers requests — the handshake the core documents and the one a box
 * accepted from this client (core 2026.9.3).
 */

vi.mock("@/lib/gateway-proxy", () => ({ getGatewayToken: vi.fn(async () => "shared-token-0123456789abcdef0123456789") }));

let server: WebSocketServer | null = null;
let probeServer: http.Server | null = null;
let probed: string[] = [];
let seen: { method: string; params: unknown; connect?: Record<string, unknown> }[] = [];
/** What the fake's hello-ok carries beside the handshake fields — the snapshot a chat reads its session from. */
let helloExtra: Record<string, unknown> = {};
let lib: typeof import("@/lib/openclaw-gateway-ws");

/**
 * The gateway's own HTTP probe surface, which is what readiness is asked on:
 * `/startupz` answers 503 `{ok:false,status:"starting"}` until the gateway has
 * finished starting and 200 `{ok:true,status:"started"}` after. Unauthenticated
 * — the aggregate boolean carries no detail, so no token is involved anywhere
 * in this fake.
 */
async function fakeProbes(answer: (path: string, attempt: number) => number): Promise<number> {
  probeServer = http.createServer((req, res) => {
    const path = req.url ?? "";
    probed.push(path);
    const status = answer(path, probed.filter((p) => p === path).length);
    const body = JSON.stringify(status === 200 ? { ok: true, status: "started" } : { ok: false, status: "starting" });
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((r) => probeServer!.listen(0, "127.0.0.1", () => r()));
  return (probeServer!.address() as AddressInfo).port;
}

async function fakeGateway(handler: (method: string, params: Record<string, unknown>) => { ok: boolean; payload?: unknown; error?: unknown }): Promise<number> {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => server!.once("listening", () => r()));
  server.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n", ts: Date.now() } }));
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.method === "connect") {
        seen.push({ method: "connect", params: f.params, connect: f.params });
        const ok = f.params?.auth?.token === "shared-token-0123456789abcdef0123456789"
          && f.params?.client?.id === "cli" && f.params?.client?.mode === "cli";
        ws.send(JSON.stringify(ok
          ? { type: "res", id: f.id, ok: true, payload: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: f.params.scopes }, ...helloExtra } }
          : { type: "res", id: f.id, ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }));
        return;
      }
      seen.push({ method: f.method, params: f.params });
      const r = handler(f.method, f.params ?? {});
      ws.send(JSON.stringify(r.ok ? { type: "res", id: f.id, ok: true, payload: r.payload } : { type: "res", id: f.id, ok: false, error: r.error }));
    });
  });
  return (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  seen = [];
  probed = [];
  helloExtra = {};
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await new Promise<void>((r) => (probeServer ? probeServer.close(() => r()) : r()));
  probeServer = null;
  vi.unstubAllEnvs();
});

async function load(port: number) {
  vi.stubEnv("GATEWAY_PORT", String(port));
  vi.resetModules();
  lib = await import("@/lib/openclaw-gateway-ws");
}

describe("gatewayWsCall", () => {
  it("does the documented handshake with the shared token and returns the response payload", async () => {
    const port = await fakeGateway((method) => (method === "sessions.list" ? { ok: true, payload: { sessions: [{ key: "agent:main:main" }] } } : { ok: false, error: { code: "NOT_FOUND" } }));
    await load(port);
    const out = await lib.gatewayWsCall("sessions.list", { limit: 1 });
    expect(out).toEqual({ sessions: [{ key: "agent:main:main" }] });
    expect(seen[0].connect).toMatchObject({ minProtocol: 4, maxProtocol: 4, role: "operator", client: { id: "cli", mode: "cli" } });
    expect(seen[0].connect?.scopes).toEqual(["operator.read", "operator.write", "operator.admin"]);
    expect(seen[1]).toMatchObject({ method: "sessions.list", params: { limit: 1 } });
  });

  it("raises the gateway's own error, with its code, when the call is refused", async () => {
    const port = await fakeGateway(() => ({ ok: false, error: { code: "INVALID_REQUEST", message: "invalid config.patch params" } }));
    await load(port);
    await expect(lib.gatewayWsCall("config.patch", {})).rejects.toMatchObject({ name: "GatewayRpcError", code: "INVALID_REQUEST", message: "invalid config.patch params" });
  });

  it("reports the gateway as unavailable — the CLI's case — when nothing listens", async () => {
    await load(1); // a port nothing listens on
    await expect(lib.gatewayWsCall("sessions.list", {})).rejects.toMatchObject({ name: "GatewayWsUnavailableError" });
  });

  it("reports unavailable, not a call failure, when the handshake is refused", async () => {
    const port = await fakeGateway(() => ({ ok: true, payload: {} }));
    await load(port);
    const proxy = await import("@/lib/gateway-proxy");
    vi.mocked(proxy.getGatewayToken).mockResolvedValueOnce("wrong");
    await expect(lib.gatewayWsCall("sessions.list", {})).rejects.toMatchObject({ name: "GatewayWsUnavailableError", message: "bad token" });
  });
});

describe("gatewayWsChatSendMain", () => {
  it("posts into the session the hello names as main — the key the web chat binds to — on the same connection", async () => {
    helloExtra = { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } };
    const port = await fakeGateway((method) => (method === "chat.send" ? { ok: true, payload: { runId: "r1", status: "started" } } : { ok: false, error: { code: "NOT_FOUND" } }));
    await load(port);
    const out = await lib.gatewayWsChatSendMain("[Coding team team-k3x9q2ab · worker run-ab12cd34] Stripe or PayPal?", { idempotencyKey: "idem-1" });
    expect(out).toEqual({ sessionKey: "agent:main:main" });
    expect(seen.map((s) => s.method)).toEqual(["connect", "chat.send"]);
    expect(seen[1].params).toEqual({ sessionKey: "agent:main:main", message: "[Coding team team-k3x9q2ab · worker run-ab12cd34] Stripe or PayPal?", deliver: false, idempotencyKey: "idem-1" });
  });

  it("falls back to `main`, as the chat does, when the hello names no session", async () => {
    const port = await fakeGateway(() => ({ ok: true, payload: {} }));
    await load(port);
    expect(await lib.gatewayWsChatSendMain("hi", { idempotencyKey: "idem-2" })).toEqual({ sessionKey: "main" });
    expect(seen[1].params).toMatchObject({ sessionKey: "main" });
    expect(lib.mainSessionKeyOf({ snapshot: { sessionDefaults: { mainSessionKey: "  " } } })).toBe("main");
  });

  it("is unavailable when nothing listens, and the gateway's own error when the send is refused", async () => {
    await load(1);
    await expect(lib.gatewayWsChatSendMain("hi", { idempotencyKey: "idem-3" })).rejects.toMatchObject({ name: "GatewayWsUnavailableError" });
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    const port = await fakeGateway(() => ({ ok: false, error: { code: "INVALID_REQUEST", message: "session is busy" } }));
    await load(port);
    await expect(lib.gatewayWsChatSendMain("hi", { idempotencyKey: "idem-4" })).rejects.toMatchObject({ name: "GatewayRpcError", code: "INVALID_REQUEST" });
  });
});

describe("gatewayWsPatchConfig", () => {
  it("reads the hash, then patches with the raw merge and answers what changed", async () => {
    const port = await fakeGateway((method, params) => {
      if (method === "config.get") return { ok: true, payload: { hash: "hmac-abc", config: {} } };
      if (method === "config.patch") return params.baseHash === "hmac-abc" && typeof params.raw === "string"
        ? { ok: true, payload: { ok: true, noop: false, changedPaths: ["agents.defaults.model.primary"] } }
        : { ok: false, error: { code: "BAD", message: "shape" } };
      return { ok: false, error: { code: "NOT_FOUND" } };
    });
    await load(port);
    const out = await lib.gatewayWsPatchConfig({ agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } });
    expect(out).toEqual({ noop: false, changedPaths: ["agents.defaults.model.primary"] });
    const patch = seen.find((s) => s.method === "config.patch")?.params as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({ agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } });
  });
});

/**
 * Readiness is the HARNESS's own answer, asked on the gateway's own HTTP port.
 * These were the untested lines behind two defects: a `config.get` poll that
 * re-invented a probe the core serves, and the "no gateway token" early-out
 * that reported a perfectly healthy gateway as one that would never answer.
 */
describe("waitForGatewayRpcReady", () => {
  it("polls the gateway's startup probe and answers true once it has started", async () => {
    const port = await fakeProbes((_path, attempt) => (attempt >= 3 ? 200 : 503));
    await load(port);
    await expect(lib.waitForGatewayRpcReady(5_000, 10)).resolves.toBe(true);
    expect(probed).toEqual(["/startupz", "/startupz", "/startupz"]);
  });

  it("answers false, never throws, when the budget runs out with the gateway still starting", async () => {
    const port = await fakeProbes(() => 503);
    await load(port);
    await expect(lib.waitForGatewayRpcReady(120, 10)).resolves.toBe(false);
    expect(probed.length).toBeGreaterThan(0);
  });

  it("answers false rather than throwing when nothing is listening at all", async () => {
    await load(1); // a port nothing listens on
    await expect(lib.waitForGatewayRpcReady(50, 10)).resolves.toBe(false);
  });

  it("needs no gateway token: a box whose shared token this server cannot read is still waited for", async () => {
    // The regression this pins: the WS poll answered false the instant
    // `getGatewayToken()` came back empty — a Hermes host, a `${ENV}`
    // interpolation, an unreadable openclaw.json — so a healthy gateway was
    // reported as one that would never answer and the sweep it gated was
    // skipped outright. The probe is unauthenticated, so the token is not read.
    const port = await fakeProbes(() => 200);
    await load(port);
    const proxy = await import("@/lib/gateway-proxy");
    vi.mocked(proxy.getGatewayToken).mockResolvedValue("");
    await expect(lib.waitForGatewayRpcReady(5_000, 10)).resolves.toBe(true);
    expect(vi.mocked(proxy.getGatewayToken)).not.toHaveBeenCalled();
  });

  it("asks once, and gives up, on a budget that is zero or nonsense", async () => {
    const port = await fakeProbes(() => 503);
    await load(port);
    await expect(lib.waitForGatewayRpcReady(0, 10)).resolves.toBe(false);
    await expect(lib.waitForGatewayRpcReady(Number.NaN, 10)).resolves.toBe(false);
    expect(probed).toEqual(["/startupz", "/startupz"]);
  });
});
