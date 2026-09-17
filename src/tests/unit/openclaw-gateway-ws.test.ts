import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * The gateway's RPC spoken in-process. A fake gateway stands in: it sends the
 * connect challenge, checks the shared token, answers `hello-ok`, then
 * answers requests — the handshake the core documents and the one a box
 * accepted from this client (core 2026.9.3).
 */

vi.mock("@/lib/gateway-proxy", () => ({ getGatewayToken: vi.fn(async () => "shared-token-0123456789abcdef0123456789") }));

let server: WebSocketServer | null = null;
let seen: { method: string; params: unknown; connect?: Record<string, unknown> }[] = [];
let lib: typeof import("@/lib/openclaw-gateway-ws");

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
          ? { type: "res", id: f.id, ok: true, payload: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: f.params.scopes } } }
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
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
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
