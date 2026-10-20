import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket, WebSocketServer } from "ws";

// The chat socket of a ClawBox user who is not the owner
// (scripts/gateway-user-relay.js): they never hold the gateway's token, their
// chat reaches only their own sessions, and nothing of the owner's chat is on
// the wire to them. The filters are judged frame by frame, then the whole
// relay is run between a real browser-side socket and a stand-in gateway.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const requireCjs = createRequire(import.meta.url);
const relay = requireCjs("../../../scripts/gateway-user-relay.js") as {
  RELAY_SCOPES: readonly string[];
  RESET_SCOPES: readonly string[];
  createRelayState(username: string): Record<string, unknown> & { connectId: string | null; connected: boolean; challenge: unknown };
  filterClientFrame(state: unknown, frame: unknown): { toGateway?: Record<string, unknown>; toClient?: Record<string, unknown>; reset?: { id: string; params: Record<string, unknown> } };
  filterGatewayFrame(state: unknown, frame: unknown): { toClient?: Record<string, unknown> };
  userHello(state: unknown, payload: unknown): Record<string, unknown>;
  buildRelayConnect(state: unknown, frame: unknown, opts: { token: string; identity: unknown }): Record<string, unknown>;
  loadOrCreateRelayIdentity(file: string): { privateKey: crypto.KeyObject; publicKey: string };
  readGatewayToken(file: string): string;
  relayUserChat(opts: Record<string, unknown>): void;
};

const ALICE_MAIN = "agent:main:clawbox-user-alice";
const ALICE_TAB = "agent:main:clawbox-utab-0123456789ab-alice";

function connected(): ReturnType<typeof relay.createRelayState> {
  const state = relay.createRelayState("alice");
  state.connectId = "c1";
  state.connected = true;
  return state;
}

describe("requests from a user's chat", () => {
  it.each([
    ["chat.send", { sessionKey: ALICE_MAIN, message: "hi", idempotencyKey: "k" }],
    ["chat.history", { sessionKey: ALICE_TAB, limit: 50 }],
    ["chat.abort", { sessionKey: ALICE_MAIN }],
    ["sessions.patch", { key: ALICE_MAIN, thinkingLevel: "low" }],
    ["sessions.delete", { key: ALICE_TAB, deleteTranscript: true }],
    ["sessions.messages.subscribe", { key: ALICE_MAIN, includeApprovals: true }],
    ["progressCard.get", { sessionKey: ALICE_MAIN }],
    ["commands.list", { scope: "text" }],
    ["question.list", {}],
  ])("passes %s on the user's own session", (method, params) => {
    const frame = { type: "req", id: "r1", method, params };
    expect(relay.filterClientFrame(connected(), frame)).toEqual({ toGateway: frame });
  });

  it("hands a reset of the user's own session to the relay's admin socket, with only key and reason", () => {
    const out = relay.filterClientFrame(connected(), { type: "req", id: "r9", method: "sessions.reset", params: { key: ALICE_TAB, reason: "new", extra: "x" } });
    expect(out).toEqual({ reset: { id: "r9", params: { key: ALICE_TAB, reason: "new" } } });
  });

  it.each([
    ["chat.history", { sessionKey: "agent:main:main" }],
    ["sessions.reset", { key: "agent:main:main" }],
    ["sessions.reset", { key: "agent:main:clawbox-user-bob" }],
    ["sessions.reset", {}],
    ["chat.send", { sessionKey: "agent:main:main", message: "what did the owner say?" }],
    ["chat.send", { message: "no key lands in the gateway's default main" }],
    ["chat.history", { sessionKey: "agent:main:clawbox-0123456789ab" }],
    ["chat.history", { sessionKey: "agent:main:clawbox-user-bob" }],
    ["sessions.delete", { key: "agent:main:main" }],
    ["sessions.messages.subscribe", { key: "agent:main:main" }],
  ])("refuses %s on someone else's session", (method, params) => {
    const out = relay.filterClientFrame(connected(), { type: "req", id: "r2", method, params });
    expect(out.toGateway).toBeUndefined();
    expect(out.toClient).toMatchObject({ type: "res", id: "r2", ok: false, error: { code: "FORBIDDEN" } });
  });

  it.each(["config.get", "config.patch", "sessions.list", "chat.inject", "node.pair.approve", "agents.list"])(
    "refuses %s outright — nothing the chat sends needs it",
    (method) => {
      const out = relay.filterClientFrame(connected(), { type: "req", id: "r3", method, params: {} });
      expect(out.toGateway).toBeUndefined();
      expect(out.toClient).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    },
  );

  it("refuses a second connect, and drops anything that is not a request", () => {
    expect(relay.filterClientFrame(connected(), { type: "req", id: "x", method: "connect", params: {} }).toClient).toMatchObject({ ok: false });
    expect(relay.filterClientFrame(connected(), { type: "event", event: "chat" })).toEqual({});
    expect(relay.filterClientFrame(connected(), "not json")).toEqual({});
  });
});

describe("what the gateway sends to a user's chat", () => {
  it("rewrites the hello to the user's own main key and never forwards the gateway's device token", () => {
    const state = relay.createRelayState("alice");
    state.connectId = "c1";
    const out = relay.filterGatewayFrame(state, {
      type: "res",
      id: "c1",
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        server: { version: "2026.10.3" },
        features: { methods: ["chat.send"] },
        snapshot: {
          sessionDefaults: { mainSessionKey: "agent:main:main", defaultAgentId: "main" },
          presence: [{ host: "owner-laptop" }],
          health: { channels: {} },
        },
        auth: { deviceToken: "secret-device-token" },
        policy: { tickIntervalMs: 30000 },
      },
    });
    expect(state.connected).toBe(true);
    const hello = out.toClient!.payload as Record<string, unknown>;
    expect(hello.snapshot).toEqual({ sessionDefaults: { mainSessionKey: ALICE_MAIN, defaultAgentId: "main" } });
    expect(JSON.stringify(out.toClient)).not.toContain("secret-device-token");
    expect(JSON.stringify(out.toClient)).not.toContain("owner-laptop");
    expect(hello.features).toEqual({ methods: ["chat.send"] });
  });

  it("passes only events about the user's own sessions", () => {
    const state = connected();
    const mine = { type: "event", event: "chat", payload: { sessionKey: ALICE_MAIN, state: "delta" } };
    const owners = { type: "event", event: "chat", payload: { sessionKey: "agent:main:main", state: "delta", message: "owner's words" } };
    expect(relay.filterGatewayFrame(state, mine)).toEqual({ toClient: mine });
    expect(relay.filterGatewayFrame(state, owners)).toEqual({});
    expect(relay.filterGatewayFrame(state, { type: "event", event: "agent", payload: { sessionKey: "agent:main:main", stream: "tool" } })).toEqual({});
    expect(relay.filterGatewayFrame(state, { type: "event", event: "agent", payload: { stream: "tool" } })).toEqual({});
    expect(relay.filterGatewayFrame(state, { type: "event", event: "session.message", payload: { sessionKey: ALICE_TAB } }).toClient).toBeTruthy();
    expect(relay.filterGatewayFrame(state, { type: "event", event: "presence", payload: {} })).toEqual({});
    expect(relay.filterGatewayFrame(state, { type: "event", event: "connect.challenge", payload: { nonce: "n" } }).toClient).toBeTruthy();
  });

  it("passes an approval when either of its keys is the user's", () => {
    const state = connected();
    const theirs = { type: "event", event: "session.approval", payload: { sessionKey: "agent:main:main", approval: {} } };
    const ours = { type: "event", event: "session.approval", payload: { sessionKey: "agent:main:main", sourceSessionKey: ALICE_MAIN, approval: {} } };
    expect(relay.filterGatewayFrame(state, theirs)).toEqual({});
    expect(relay.filterGatewayFrame(state, ours)).toEqual({ toClient: ours });
  });

  it("answers a question's resolution only for a question the user was shown", () => {
    const state = connected();
    expect(relay.filterGatewayFrame(state, { type: "event", event: "question.resolved", payload: { id: "q-owner", answers: ["yes"] } })).toEqual({});
    relay.filterGatewayFrame(state, { type: "event", event: "question.requested", payload: { id: "q-mine", sessionKey: ALICE_MAIN } });
    expect(relay.filterGatewayFrame(state, { type: "event", event: "question.resolved", payload: { id: "q-mine" } }).toClient).toBeTruthy();
  });

  it("cuts question.list to the user's own pending questions", () => {
    const state = connected();
    relay.filterClientFrame(state, { type: "req", id: "ql", method: "question.list", params: {} });
    const out = relay.filterGatewayFrame(state, {
      type: "res",
      id: "ql",
      ok: true,
      payload: { questions: [{ id: "a", sessionKey: ALICE_MAIN }, { id: "b", sessionKey: "agent:main:main" }] },
    });
    expect((out.toClient!.payload as { questions: unknown[] }).questions).toEqual([{ id: "a", sessionKey: ALICE_MAIN }]);
  });

  it("drops a response to a request the user never sent", () => {
    expect(relay.filterGatewayFrame(connected(), { type: "res", id: "someone-else", ok: true, payload: {} })).toEqual({});
  });
});

describe("the relay's own handshake", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-relay-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("signs OpenClaw's v3 device payload with a key kept in a 0600 file", () => {
    const file = path.join(dir, "data", ".gateway-user-relay-device.json");
    const identity = relay.loadOrCreateRelayIdentity(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(relay.loadOrCreateRelayIdentity(file).publicKey).toBe(identity.publicKey);

    const state = relay.createRelayState("alice");
    state.challenge = { nonce: "nonce-1", ts: 1760000000000 };
    const frame = relay.buildRelayConnect(state, { type: "req", id: "c1", method: "connect", params: { auth: { token: "" }, locale: "de" } }, { token: "gw-token", identity });
    const params = frame.params as { auth: unknown; scopes: string[]; client: unknown; device: { id: string; signature: string } };
    expect(frame).toMatchObject({ id: "c1", method: "connect" });
    expect(params.auth).toEqual({ token: "gw-token" });
    expect(params.scopes).toEqual([...relay.RELAY_SCOPES]);
    expect(params.scopes).not.toContain("operator.admin");
    expect(params.client).toMatchObject({ id: "openclaw-control-ui", mode: "webchat" });

    const pub = Buffer.from(identity.publicKey, "base64url");
    expect(params.device.id).toBe(crypto.createHash("sha256").update(pub).digest("hex"));
    const signed = ["v3", params.device.id, "openclaw-control-ui", "webchat", "operator", params.scopes.join(","), "1760000000000", "gw-token", "nonce-1", "linux", ""].join("|");
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: identity.publicKey }, format: "jwk" });
    expect(crypto.verify(null, Buffer.from(signed), key, Buffer.from(params.device.signature, "base64url"))).toBe(true);
  });

  it("reads the gateway token the way the owner's ws-config does, and never an unresolved reference", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ gateway: { auth: { token: "abc" } } }));
    expect(relay.readGatewayToken(cfg)).toBe("abc");
    fs.writeFileSync(cfg, JSON.stringify({ gateway: { auth: { token: "${OPENCLAW_TOKEN}" } } }));
    expect(relay.readGatewayToken(cfg)).toBe("");
    expect(relay.readGatewayToken(path.join(dir, "missing.json"))).toBe("");
  });
});

describe("a user's chat end to end through the relay", () => {
  let gateway: WebSocketServer;
  let front: WebSocketServer;
  let dir: string;
  type Frame = { type?: string; id?: string; method?: string; event?: string; ok?: boolean; params?: Record<string, unknown> & { auth?: unknown; sessionKey?: string; device?: { signature?: string } }; payload?: Record<string, unknown> & { snapshot?: { sessionDefaults: { mainSessionKey: string } } } };
  let seenByGateway: Frame[];
  let port: number;
  // When set, the stand-in gateway holds every reset's answer until it resolves.
  let resetGate: Promise<void> | null;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-relay-e2e-"));
    seenByGateway = [];
    resetGate = null;
    // A stand-in gateway: challenge, hello naming the owner's main, and a
    // broadcast of BOTH the owner's and the user's chat to every socket.
    gateway = new WebSocketServer({ port: 0 });
    gateway.on("connection", (ws) => {
      let scopes: string[] = [];
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1", ts: 1760000000000 } }));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        seenByGateway.push(frame);
        if (frame.method === "connect") {
          scopes = frame.params.scopes;
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } }, auth: { deviceToken: "dt" } } }));
          ws.send(JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: "agent:main:main", state: "final", message: "OWNER-SECRET-TURN" } }));
          return;
        }
        if (frame.method === "sessions.reset") {
          // OpenClaw's rule for callers that declare scopes.
          const answer = JSON.stringify(scopes.includes("operator.admin")
            ? { type: "res", id: frame.id, ok: true, payload: { ok: true, key: frame.params.key } }
            : { type: "res", id: frame.id, ok: false, error: { code: "INVALID_REQUEST", message: "Gateway resets require operator.admin." } });
          if (resetGate) void resetGate.then(() => ws.send(answer));
          else ws.send(answer);
          return;
        }
        if (frame.method === "chat.send") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId: "r" } }));
          ws.send(JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: frame.params.sessionKey, state: "final", message: "hello alice" } }));
        }
      });
    });
    await new Promise<void>((resolve) => gateway.on("listening", () => resolve()));
    const gwPort = (gateway.address() as { port: number }).port;

    const identity = relay.loadOrCreateRelayIdentity(path.join(dir, "device.json"));
    front = new WebSocketServer({ port: 0 });
    front.on("connection", (clientWs) => {
      relay.relayUserChat({
        clientWs,
        username: "alice",
        token: "gw-token",
        identity,
        connectUpstream: () => new WebSocket(`ws://127.0.0.1:${gwPort}/`),
      });
    });
    await new Promise<void>((resolve) => front.on("listening", () => resolve()));
    port = (front.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("connects with the box's token for a browser that has none, and shows only the user's own chat", async () => {
    const browser = new WebSocket(`ws://127.0.0.1:${port}/`);
    const received: Frame[] = [];
    const done = new Promise<void>((resolve, reject) => {
      browser.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "conn", method: "connect", params: { auth: { token: "" } } }));
        } else if (frame.id === "conn") {
          const main = frame.payload.snapshot.sessionDefaults.mainSessionKey;
          browser.send(JSON.stringify({ type: "req", id: "peek", method: "chat.history", params: { sessionKey: "agent:main:main" } }));
          browser.send(JSON.stringify({ type: "req", id: "send", method: "chat.send", params: { sessionKey: main, message: "hi" } }));
        } else if (frame.event === "chat") {
          resolve();
        }
      });
      browser.on("error", reject);
    });
    await done;
    browser.close();

    const connect = seenByGateway.find((f) => f.method === "connect")!;
    expect(connect.params?.auth).toEqual({ token: "gw-token" });
    expect(connect.params?.device?.signature).toBeTruthy();
    // The user's peek at the owner's main never reached the gateway…
    expect(seenByGateway.some((f) => f.method === "chat.history")).toBe(false);
    expect(received.find((f) => f.id === "peek")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    // …their own turn did, under their own key…
    expect(seenByGateway.find((f) => f.method === "chat.send")?.params?.sessionKey).toBe(ALICE_MAIN);
    // …and the owner's broadcast turn never reached the browser.
    expect(JSON.stringify(received)).not.toContain("OWNER-SECRET-TURN");
    expect(JSON.stringify(received)).not.toContain("\"dt\"");
    expect(received.find((f) => f.event === "chat")).toMatchObject({ payload: { sessionKey: ALICE_MAIN, message: "hello alice" } });
  });

  it("runs a user's /new on the relay's own admin socket, for their session only", async () => {
    const browser = new WebSocket(`ws://127.0.0.1:${port}/`);
    const received: Frame[] = [];
    await new Promise<void>((resolve, reject) => {
      browser.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "conn", method: "connect", params: { auth: { token: "" } } }));
        } else if (frame.id === "conn") {
          browser.send(JSON.stringify({ type: "req", id: "theirs", method: "sessions.reset", params: { key: "agent:main:main", reason: "new" } }));
          browser.send(JSON.stringify({ type: "req", id: "mine", method: "sessions.reset", params: { key: ALICE_MAIN, reason: "new" } }));
        } else if (frame.id === "mine") {
          resolve();
        }
      });
      browser.on("error", reject);
    });
    browser.close();

    expect(received.find((f) => f.id === "mine")).toMatchObject({ type: "res", ok: true, payload: { key: ALICE_MAIN } });
    expect(received.find((f) => f.id === "theirs")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const resets = seenByGateway.filter((f) => f.method === "sessions.reset");
    expect(resets).toHaveLength(1);
    expect(resets[0].params).toEqual({ key: ALICE_MAIN, reason: "new" });
    // The browser's own socket never declared admin; only the one-shot reset socket did.
    const connects = seenByGateway.filter((f) => f.method === "connect");
    expect(connects.map((f) => f.params?.scopes)).toEqual([[...relay.RELAY_SCOPES], [...relay.RESET_SCOPES]]);
    expect(JSON.stringify(received)).not.toContain("operator.admin");
  });

  it("keeps one admin reset socket per chat: a reset sent while one runs is refused, the next one after it runs", async () => {
    let release!: () => void;
    resetGate = new Promise<void>((resolve) => { release = resolve; });
    const browser = new WebSocket(`ws://127.0.0.1:${port}/`);
    const received: Frame[] = [];
    await new Promise<void>((resolve, reject) => {
      browser.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "conn", method: "connect", params: { auth: { token: "" } } }));
        } else if (frame.id === "conn") {
          for (let i = 0; i < 5; i++) {
            browser.send(JSON.stringify({ type: "req", id: `burst-${i}`, method: "sessions.reset", params: { key: ALICE_MAIN, reason: "new" } }));
          }
        } else if (frame.id === "burst-4") {
          // The last of the burst was refused while the first is still held: let it finish.
          release();
        } else if (frame.id === "burst-0") {
          browser.send(JSON.stringify({ type: "req", id: "after", method: "sessions.reset", params: { key: ALICE_MAIN, reason: "new" } }));
        } else if (frame.id === "after") {
          resolve();
        }
      });
      browser.on("error", reject);
    });
    browser.close();

    expect(received.find((f) => f.id === "burst-0")).toMatchObject({ type: "res", ok: true, payload: { key: ALICE_MAIN } });
    for (let i = 1; i < 5; i++) {
      expect(received.find((f) => f.id === `burst-${i}`)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
    expect(received.find((f) => f.id === "after")).toMatchObject({ type: "res", ok: true, payload: { key: ALICE_MAIN } });
    // The burst opened one admin socket, and the reset after it one more.
    const adminConnects = seenByGateway.filter((f) => f.method === "connect" && (f.params?.scopes as string[] | undefined)?.includes("operator.admin"));
    expect(adminConnects).toHaveLength(2);
    expect(seenByGateway.filter((f) => f.method === "sessions.reset")).toHaveLength(2);
  });

  it("closes the browser's socket when the box has no gateway token to speak with", async () => {
    await new Promise<void>((resolve) => front.close(() => resolve()));
    front = new WebSocketServer({ port: 0 });
    front.on("connection", (clientWs) => {
      relay.relayUserChat({ clientWs, username: "alice", token: "", identity: null, connectUpstream: () => { throw new Error("must not dial"); } });
    });
    await new Promise<void>((resolve) => front.on("listening", () => resolve()));
    const browser = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}/`);
    const code = await new Promise<number>((resolve) => browser.on("close", (c) => resolve(c)));
    expect(code).toBe(1011);
  });
});
