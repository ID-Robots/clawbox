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
  typedResetCommand(message: unknown): { action: "new" | "reset"; tail: string } | null;
  filterClientFrame(state: unknown, frame: unknown): {
    toGateway?: Record<string, unknown>;
    toClient?: Record<string, unknown>;
    reset?: { id: string; params: Record<string, unknown>; chat?: { send?: Record<string, unknown>; notice?: Record<string, unknown> } };
  };
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

  it("passes a clear of the user's own progress card, and never a note or a plan", () => {
    const out = relay.filterClientFrame(connected(), {
      type: "req", id: "p1", method: "progressCard.put",
      params: { sessionKey: ALICE_TAB, expectedRevision: 3, markdown: "written by the user", plan: [{ step: "x", status: "pending" }], agentId: "other" },
    });
    expect(out).toEqual({ toGateway: { type: "req", id: "p1", method: "progressCard.put", params: { sessionKey: ALICE_TAB, expectedRevision: 3 } } });
  });

  it.each([undefined, "3", 0, -1, 2.5])("refuses a clear of the user's own card without a usable revision (%s)", (expectedRevision) => {
    const out = relay.filterClientFrame(connected(), { type: "req", id: "p2", method: "progressCard.put", params: { sessionKey: ALICE_MAIN, expectedRevision } });
    expect(out.toGateway).toBeUndefined();
    expect(out.toClient).toMatchObject({ type: "res", id: "p2", ok: false, error: { code: "FORBIDDEN" } });
  });

  it("passes a refresh of the user's own progress card with just its session and retry key", () => {
    const out = relay.filterClientFrame(connected(), {
      type: "req", id: "p3", method: "progressCard.refresh",
      params: { sessionKey: ALICE_MAIN, idempotencyKey: "k-1", prompt: "do something else" },
    });
    expect(out).toEqual({ toGateway: { type: "req", id: "p3", method: "progressCard.refresh", params: { sessionKey: ALICE_MAIN, idempotencyKey: "k-1" } } });
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
    ["progressCard.get", { sessionKey: "agent:main:main" }],
    ["progressCard.put", { sessionKey: "agent:main:main", expectedRevision: 2 }],
    ["progressCard.put", { sessionKey: "agent:main:clawbox-user-bob" }],
    ["progressCard.put", {}],
    ["progressCard.refresh", { sessionKey: "agent:main:main", idempotencyKey: "k" }],
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

// TASK-2520: the chat sends a typed /new or /reset as the text of a chat.send,
// and the core refuses that from a socket without operator.admin. The relay
// runs it as the reset it already runs for `sessions.reset`.
describe("a typed /new or /reset from a user's chat", () => {
  const typed = (message: unknown, extra: Record<string, unknown> = {}) => ({
    type: "req", id: "s1", method: "chat.send",
    params: { sessionKey: ALICE_MAIN, message, deliver: false, idempotencyKey: "idem-1", ...extra },
  });

  it.each([
    ["/new", "new"],
    ["/reset", "reset"],
    ["  /NEW \n", "new"],
    ["/Reset", "reset"],
    ["/new:", "new"],
  ])("runs bare %j as a reset of the user's own session, to be answered with the core's notice", (message, action) => {
    expect(relay.filterClientFrame(connected(), typed(message))).toEqual({
      reset: { id: "s1", params: { key: ALICE_MAIN, reason: action }, chat: { notice: { runId: "idem-1", sessionKey: ALICE_MAIN, action } } },
    });
  });

  it.each([
    ["/new hello", "new", "hello"],
    ["/reset and now something else", "reset", "and now something else"],
    ["/new: hello", "new", "hello"],
    ["/new\nfirst line\nsecond line", "new", "first line\nsecond line"],
    ["/reset softly does it", "reset", "softly does it"],
  ])("resets for %j and keeps the message after the command for the user's own socket", (message, action, tail) => {
    // The admin socket is given the key and the command's name; the message
    // travels afterwards as the chat.send it would have been, minus the command.
    expect(relay.filterClientFrame(connected(), typed(message, { thinking: "low" }))).toEqual({
      reset: {
        id: "s1",
        params: { key: ALICE_MAIN, reason: action },
        chat: { send: { type: "req", id: "s1", method: "chat.send", params: { sessionKey: ALICE_MAIN, message: tail, deliver: false, idempotencyKey: "idem-1", thinking: "low" } } },
      },
    });
  });

  it("resets a tab of the user's own the same way", () => {
    const out = relay.filterClientFrame(connected(), typed("/new", { sessionKey: ALICE_TAB }));
    expect(out.reset?.params).toEqual({ key: ALICE_TAB, reason: "new" });
  });

  it.each(["agent:main:main", "agent:main:clawbox-user-bob", "agent:main:clawbox-utab-0123456789ab-bob", "agent:main:clawbox-0123456789ab", undefined])(
    "refuses a typed /new or /reset on a session that is not the user's (%s)",
    (sessionKey) => {
      for (const message of ["/new", "/reset", "/new hello"]) {
        const out = relay.filterClientFrame(connected(), typed(message, { sessionKey }));
        expect(out.reset).toBeUndefined();
        expect(out.toGateway).toBeUndefined();
        expect(out.toClient).toMatchObject({ type: "res", id: "s1", ok: false, error: { code: "FORBIDDEN" } });
      }
    },
  );

  it.each([
    "/reset soft",
    "/reset soft and keep going",
    "/reset: soft",
    "/newer model",
    "/resetting",
    "/model gpt-5",
    "/status",
    "tell me about /new",
    "new",
  ])("leaves %j to the gateway: not a reset the relay runs", (message) => {
    const frame = typed(message);
    expect(relay.filterClientFrame(connected(), frame)).toEqual({ toGateway: frame });
  });

  it("answers a bare command under a run of its own when the chat named none", () => {
    const out = relay.filterClientFrame(connected(), { type: "req", id: "s2", method: "chat.send", params: { sessionKey: ALICE_MAIN, message: "/new" } });
    expect(out.reset?.chat?.notice).toMatchObject({ sessionKey: ALICE_MAIN, action: "new", runId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("reads a message that is not text as no command", () => {
    expect(relay.typedResetCommand(undefined)).toBeNull();
    expect(relay.typedResetCommand({ text: "/new" })).toBeNull();
    expect(relay.typedResetCommand("/new")).toEqual({ action: "new", tail: "" });
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
  type Frame = { type?: string; id?: string; method?: string; event?: string; ok?: boolean; error?: { code?: string; message?: string }; params?: Record<string, unknown> & { auth?: unknown; sessionKey?: string; device?: { signature?: string } }; payload?: Record<string, unknown> & { snapshot?: { sessionDefaults: { mainSessionKey: string } } } };
  // What reached the stand-in gateway, and whether on a socket that declared operator.admin.
  let seenByGateway: Array<Frame & { admin: boolean }>;
  let port: number;
  let gwPort: number;
  let identity: ReturnType<typeof relay.loadOrCreateRelayIdentity>;
  // When set, the stand-in gateway holds every reset's answer until it resolves.
  let resetGate: Promise<void> | null;
  // When set, the stand-in gateway answers every reset with a failure.
  let resetFails: boolean;
  // OpenClaw's answer to a typed /new or /reset from a socket without operator.admin.
  const CORE_REFUSAL = "You are not authorized to reset this session. Gateway resets require operator.admin and command access.";

  /**
   * A browser-side chat socket through the relay at `at`: connects, hands
   * `onHello` the user's main key, then `onFrame` every frame until it calls
   * `done`. Resolves with everything the browser received.
   */
  function browse(
    at: number,
    onHello: (send: (frame: Frame) => void, main: string) => void,
    onFrame: (frame: Frame, send: (frame: Frame) => void, done: () => void) => void,
  ): Promise<Frame[]> {
    const browser = new WebSocket(`ws://127.0.0.1:${at}/`);
    const received: Frame[] = [];
    const send = (frame: Frame) => browser.send(JSON.stringify(frame));
    return new Promise<Frame[]>((resolve, reject) => {
      const done = () => { browser.close(); resolve(received); };
      browser.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (frame.event === "connect.challenge") send({ type: "req", id: "conn", method: "connect", params: { auth: { token: "" } } });
        else if (frame.id === "conn") onHello(send, frame.payload.snapshot.sessionDefaults.mainSessionKey);
        else onFrame(frame, send, done);
      });
      browser.on("error", reject);
    });
  }
  const typedSend = (id: string, sessionKey: string, message: string): Frame => ({ type: "req", id, method: "chat.send", params: { sessionKey, message, deliver: false, idempotencyKey: `run-${id}` } });
  const finalText = (frame: Frame | undefined) => (frame?.payload as { message?: { content?: Array<{ text?: string }> } } | undefined)?.message?.content?.[0]?.text;
  const runFinal = (frames: Frame[], runId: string) => frames.find((f) => f.event === "chat" && f.payload?.runId === runId && f.payload?.state === "final");

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-relay-e2e-"));
    seenByGateway = [];
    resetGate = null;
    resetFails = false;
    // A stand-in gateway: challenge, hello naming the owner's main, and a
    // broadcast of BOTH the owner's and the user's chat to every socket.
    gateway = new WebSocketServer({ port: 0 });
    gateway.on("connection", (ws) => {
      let scopes: string[] = [];
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1", ts: 1760000000000 } }));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === "connect") scopes = frame.params.scopes;
        const admin = scopes.includes("operator.admin");
        seenByGateway.push({ ...frame, admin });
        if (frame.method === "connect") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } }, auth: { deviceToken: "dt" } } }));
          ws.send(JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: "agent:main:main", state: "final", message: "OWNER-SECRET-TURN" } }));
          return;
        }
        if (frame.method === "sessions.reset") {
          // OpenClaw's rule for callers that declare scopes.
          const answer = JSON.stringify(admin && !resetFails
            ? { type: "res", id: frame.id, ok: true, payload: { ok: true, key: frame.params.key } }
            : { type: "res", id: frame.id, ok: false, error: admin
              ? { code: "UNAVAILABLE", message: "Session is still active; try again in a moment." }
              : { code: "INVALID_REQUEST", message: "Gateway resets require operator.admin." } });
          if (resetGate) void resetGate.then(() => ws.send(answer));
          else ws.send(answer);
          return;
        }
        if (frame.method === "chat.history") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { sessionKey: frame.params.sessionKey, messages: [] } }));
          return;
        }
        if (frame.method === "chat.send") {
          // OpenClaw's rule for a typed /new or /reset, too: only with operator.admin.
          const refused = /^\s*\/(new|reset)(\s|:|$)/i.test(String(frame.params.message)) && !admin;
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId: "r" } }));
          ws.send(JSON.stringify({ type: "event", event: "chat", payload: { sessionKey: frame.params.sessionKey, state: "final", message: refused ? CORE_REFUSAL : "hello alice" } }));
        }
      });
    });
    await new Promise<void>((resolve) => gateway.on("listening", () => resolve()));
    gwPort = (gateway.address() as { port: number }).port;

    identity = relay.loadOrCreateRelayIdentity(path.join(dir, "device.json"));
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

  it("runs a typed /new and /reset as resets of the user's own session, answered with the core's notice and never its refusal", async () => {
    let main = "";
    const received = await browse(
      port,
      (send, mainKey) => { main = mainKey; send(typedSend("n1", main, "/new")); },
      (frame, send, done) => {
        if (runFinal([frame], "run-n1")) send(typedSend("n2", main, "/reset"));
        else if (runFinal([frame], "run-n2")) done();
      },
    );

    // The chat.send is acknowledged under its run, and the run ends with the notice.
    expect(received.find((f) => f.id === "n1")).toEqual({ type: "res", id: "n1", ok: true, payload: { runId: "run-n1", status: "started" } });
    expect(received.find((f) => f.id === "n2")).toEqual({ type: "res", id: "n2", ok: true, payload: { runId: "run-n2", status: "started" } });
    expect(runFinal(received, "run-n1")?.payload).toMatchObject({ sessionKey: ALICE_MAIN, state: "final", message: { role: "assistant" } });
    expect(finalText(runFinal(received, "run-n1"))).toBe("✅ New session started.");
    expect(finalText(runFinal(received, "run-n2"))).toBe("✅ Session reset.");
    expect(received.indexOf(received.find((f) => f.id === "n1")!)).toBeLessThan(received.indexOf(runFinal(received, "run-n1")!));
    expect(JSON.stringify(received)).not.toContain("not authorized");
    // Each ran as ONE reset of the user's own key on an admin socket of the relay's own…
    const resets = seenByGateway.filter((f) => f.method === "sessions.reset");
    expect(resets.map((f) => [f.params, f.admin])).toEqual([
      [{ key: ALICE_MAIN, reason: "new" }, true],
      [{ key: ALICE_MAIN, reason: "reset" }, true],
    ]);
    // …and the command itself never reached the gateway as a message.
    expect(seenByGateway.some((f) => f.method === "chat.send")).toBe(false);
    expect(seenByGateway.filter((f) => f.method === "connect").map((f) => f.params?.scopes)).toEqual([[...relay.RELAY_SCOPES], [...relay.RESET_SCOPES], [...relay.RESET_SCOPES]]);
    expect(JSON.stringify(received)).not.toContain("operator.admin");
  });

  it("resets for a typed \"/new hello\", then sends the message on the user's own socket into the fresh session", async () => {
    const received = await browse(
      port,
      (send, main) => send(typedSend("t1", main, "/new hello")),
      (frame, _send, done) => { if (frame.event === "chat") done(); },
    );

    // The browser's request is answered by the gateway's own ack and turn.
    expect(received.find((f) => f.id === "t1")).toMatchObject({ type: "res", ok: true, payload: { runId: "r" } });
    expect(received.find((f) => f.event === "chat")).toMatchObject({ payload: { sessionKey: ALICE_MAIN, message: "hello alice" } });
    expect(JSON.stringify(received)).not.toContain("not authorized");
    // The reset first, on the admin socket, with the key and the reason only…
    const reset = seenByGateway.findIndex((f) => f.method === "sessions.reset");
    const turn = seenByGateway.findIndex((f) => f.method === "chat.send");
    expect(reset).toBeGreaterThan(-1);
    expect(turn).toBeGreaterThan(reset);
    expect(seenByGateway[reset]).toMatchObject({ admin: true, params: { key: ALICE_MAIN, reason: "new" } });
    expect(Object.keys(seenByGateway[reset].params ?? {}).sort()).toEqual(["key", "reason"]);
    // …then the message, without the command, on the socket that never declared admin.
    expect(seenByGateway[turn]).toMatchObject({ admin: false, id: "t1", params: { sessionKey: ALICE_MAIN, message: "hello", deliver: false, idempotencyKey: "run-t1" } });
    expect(seenByGateway.filter((f) => f.method === "chat.send")).toHaveLength(1);
    // Nothing the user typed was sent on a socket that holds operator.admin.
    expect(JSON.stringify(seenByGateway.filter((f) => f.admin).map((f) => f.params))).not.toContain("hello");
  });

  it("refuses a typed /new or /reset on a session the user does not own, and opens no admin socket for it", async () => {
    const received = await browse(
      port,
      (send, main) => {
        send(typedSend("o1", "agent:main:main", "/new"));
        send(typedSend("o2", "agent:main:clawbox-user-bob", "/reset"));
        send(typedSend("o3", "agent:main:main", "/new what did the owner say?"));
        send({ type: "req", id: "probe", method: "chat.history", params: { sessionKey: main } });
      },
      (frame, _send, done) => { if (frame.id === "probe") done(); },
    );

    for (const id of ["o1", "o2", "o3"]) {
      expect(received.find((f) => f.id === id)).toMatchObject({ type: "res", ok: false, error: { code: "FORBIDDEN", message: expect.stringMatching(/someone else/) } });
    }
    expect(seenByGateway.some((f) => f.method === "sessions.reset" || f.method === "chat.send")).toBe(false);
    expect(seenByGateway.filter((f) => f.method === "connect").map((f) => f.params?.scopes)).toEqual([[...relay.RELAY_SCOPES]]);
  });

  it("reports a typed command whose reset failed as a failed send, and sends nothing of the message", async () => {
    resetFails = true;
    const received = await browse(
      port,
      (send, main) => send(typedSend("f1", main, "/new hello")),
      (frame, send, done) => {
        if (frame.id === "f1") send({ type: "req", id: "probe", method: "chat.history", params: { sessionKey: ALICE_MAIN } });
        else if (frame.id === "probe") done();
      },
    );

    expect(received.find((f) => f.id === "f1")).toMatchObject({ type: "res", ok: false, error: { message: expect.stringMatching(/still active/) } });
    expect(seenByGateway.some((f) => f.method === "chat.send")).toBe(false);
    expect(received.some((f) => f.event === "chat")).toBe(false);
  });

  it("counts a typed /new as the chat's one reset in flight", async () => {
    let release!: () => void;
    resetGate = new Promise<void>((resolve) => { release = resolve; });
    const received = await browse(
      port,
      (send, main) => {
        send({ type: "req", id: "button", method: "sessions.reset", params: { key: main, reason: "new" } });
        send(typedSend("typed", main, "/new hello"));
      },
      (frame, _send, done) => {
        if (frame.id === "typed") release();
        else if (frame.id === "button") done();
      },
    );

    expect(received.find((f) => f.id === "typed")).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: expect.stringMatching(/already running/) } });
    expect(received.find((f) => f.id === "button")).toMatchObject({ ok: true, payload: { key: ALICE_MAIN } });
    expect(seenByGateway.filter((f) => f.method === "sessions.reset")).toHaveLength(1);
    expect(seenByGateway.some((f) => f.method === "chat.send")).toBe(false);
  });

  it("runs a member of staff's typed /new as a reset of their own agent's session, and still refuses the rest", async () => {
    const STAFF_MAIN = "agent:clawbox-staff-alice:clawbox-user-alice";
    const staffFront = new WebSocketServer({ port: 0 });
    staffFront.on("connection", (clientWs) => {
      relay.relayUserChat({
        clientWs, username: "alice", token: "gw-token", identity,
        staffAgent: "clawbox-staff-alice", staffReady: () => true,
        connectUpstream: () => new WebSocket(`ws://127.0.0.1:${gwPort}/`),
      });
    });
    await new Promise<void>((resolve) => staffFront.on("listening", () => resolve()));
    try {
      let main = "";
      const received = await browse(
        (staffFront.address() as { port: number }).port,
        (send, mainKey) => {
          main = mainKey;
          send(typedSend("old", ALICE_MAIN, "/new"));
          send(typedSend("model", main, "/new gpt-5"));
          send(typedSend("reset", main, "/reset"));
          send(typedSend("new", main, "/new"));
        },
        (frame, _send, done) => { if (runFinal([frame], "run-new")) done(); },
      );

      expect(main).toBe(STAFF_MAIN);
      expect(finalText(runFinal(received, "run-new"))).toBe("✅ New session started.");
      // Their old key on the owner's agent, a model after /new, and /reset stay refused.
      expect(received.find((f) => f.id === "old")?.error?.message).toMatch(/someone else/);
      expect(received.find((f) => f.id === "model")?.error?.message).toContain("/new <model>");
      expect(received.find((f) => f.id === "reset")?.error?.message).toContain("/reset is not available");
      const resets = seenByGateway.filter((f) => f.method === "sessions.reset");
      expect(resets.map((f) => [f.params, f.admin])).toEqual([[{ key: STAFF_MAIN, reason: "new" }, true]]);
      expect(seenByGateway.some((f) => f.method === "chat.send")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => staffFront.close(() => resolve()));
    }
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
