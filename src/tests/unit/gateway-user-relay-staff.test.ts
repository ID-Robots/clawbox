import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { staffAgentEntry } from "@/lib/org-staff-agents";

// A member of staff's chat socket on an organisation box
// (scripts/gateway-user-relay.js with `staffAgent`, TASK-2444): their turns go
// only to their OWN agent, `clawbox-staff-<name>`, only while that agent is
// configured with the staff policy; /new and /reasoning are the only commands
// they may send and no inline directive reaches the gateway; a session patch
// carries no model or tool override, and a turn no routing or tool fields.

const requireCjs = createRequire(import.meta.url);
const relay = requireCjs("../../../scripts/gateway-user-relay.js") as {
  createRelayState(username: string, options?: { staffAgent?: string | null; staffReady?: () => boolean }): Record<string, unknown> & { connectId: string | null; connected: boolean };
  filterClientFrame(state: unknown, frame: unknown): {
    toGateway?: Record<string, unknown>;
    toClient?: Record<string, unknown>;
    reset?: { id: string; params: Record<string, unknown>; chat?: { send?: Record<string, unknown>; notice?: Record<string, unknown> } };
  };
  filterGatewayFrame(state: unknown, frame: unknown): { toClient?: Record<string, unknown> };
  userHello(state: unknown, payload: unknown): Record<string, unknown>;
  staffReadyReader(configPath: string, agentId: string): () => boolean;
};

const STAFF = "clawbox-staff-alice";
const MAIN = `agent:${STAFF}:clawbox-user-alice`;
const TAB = `agent:${STAFF}:clawbox-utab-0123456789ab-alice`;
const OLD_MAIN = "agent:main:clawbox-user-alice";

function member(ready = true) {
  const state = relay.createRelayState("alice", { staffAgent: STAFF, staffReady: () => ready });
  state.connectId = "c1";
  state.connected = true;
  return state;
}

const send = (message: string, extra: Record<string, unknown> = {}) => ({
  type: "req", id: "s1", method: "chat.send",
  params: { sessionKey: MAIN, message, idempotencyKey: "k1", ...extra },
});

function refused(out: ReturnType<typeof relay.filterClientFrame>): string {
  expect(out.toGateway).toBeUndefined();
  const error = (out.toClient as { ok: boolean; error: { code: string; message: string } }).error;
  expect((out.toClient as { ok: boolean }).ok).toBe(false);
  expect(error.code).toBe("FORBIDDEN");
  return error.message;
}

describe("a member of staff's conversations live on their own agent", () => {
  it("the hello names their main key on their own agent, whatever the gateway's main is", () => {
    const hello = relay.userHello(member(), { type: "hello-ok", snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
    expect((hello.snapshot as { sessionDefaults: { mainSessionKey: string } }).sessionDefaults.mainSessionKey).toBe(MAIN);
  });

  it("passes their keys on their own agent and refuses their old key on the owner's agent", () => {
    expect(relay.filterClientFrame(member(), { type: "req", id: "h", method: "chat.history", params: { sessionKey: TAB } }).toGateway).toBeDefined();
    expect(refused(relay.filterClientFrame(member(), { type: "req", id: "h", method: "chat.history", params: { sessionKey: OLD_MAIN } }))).toMatch(/someone else/);
    expect(refused(relay.filterClientFrame(member(), send("hi", { sessionKey: OLD_MAIN })))).toMatch(/someone else/);
    expect(refused(relay.filterClientFrame(member(), send("hi", { sessionKey: "agent:clawbox-staff-bob:clawbox-user-alice" })))).toMatch(/someone else/);
  });

  it("refuses a request that names another agent", () => {
    expect(refused(relay.filterClientFrame(member(), send("hi", { agentId: "main" })))).toMatch(/someone else/);
    expect(refused(relay.filterClientFrame(member(), { type: "req", id: "l", method: "commands.list", params: { agentId: "main" } }))).toMatch(/someone else/);
  });

  it("passes only events about their sessions on their own agent", () => {
    const event = (sessionKey: string) => ({ type: "event", event: "chat", payload: { sessionKey, state: "delta" } });
    expect(relay.filterGatewayFrame(member(), event(MAIN)).toClient).toBeDefined();
    expect(relay.filterGatewayFrame(member(), event(OLD_MAIN)).toClient).toBeUndefined();
    expect(relay.filterGatewayFrame(member(), event("agent:main:main")).toClient).toBeUndefined();
  });

  it("keeps a home box's user exactly as before (no staff agent)", () => {
    const state = relay.createRelayState("alice");
    state.connectId = "c1";
    state.connected = true;
    const frame = { type: "req", id: "s", method: "chat.send", params: { sessionKey: OLD_MAIN, message: "/model gpt-5", idempotencyKey: "k" } };
    expect(relay.filterClientFrame(state, frame)).toEqual({ toGateway: frame });
  });
});

describe("a member of staff's turn", () => {
  it("goes out with only the fields ClawBox's chat sends, never delivered to a channel", () => {
    const out = relay.filterClientFrame(member(), send("What is in this file?", {
      deliver: true, toolBindings: [{ tool: "exec" }], originatingChannel: "telegram", suppressCommandInterpretation: true,
      systemInputProvenance: { kind: "system" }, queueMode: "steer", workContext: { cwd: "/" }, intent: { kind: "goal" },
      expectedToolOverrides: { allow: ["exec"] }, thinking: "low",
    }));
    expect(out.toGateway).toEqual({
      type: "req", id: "s1", method: "chat.send",
      params: { deliver: false, sessionKey: MAIN, message: "What is in this file?", idempotencyKey: "k1", thinking: "low" },
    });
  });

  it("is refused while their agent is not configured with the staff policy", () => {
    expect(refused(relay.filterClientFrame(member(false), send("hello")))).toMatch(/being set up/);
  });

  it.each([
    ["/model openai/gpt-5", "/model"],
    ["/config set tools.profile full", "/config"],
    ["/restart", "/restart"],
    ["/bash ls", "/bash"],
    ["! ls", "!"],
    ["/think high", "/think"],
    ["/new gpt-5", "/new <model>"],
    ["please use /model gpt-5 for this", "/model"],
    ["/learn from this chat", "/learn"],
  ])("refuses %j", (message, command) => {
    expect(refused(relay.filterClientFrame(member(), send(message)))).toContain(command);
  });

  it.each(["/reasoning", "/reasoning on", "Read /srv/shared/q3.pdf and sum column B"])("passes %j", (message) => {
    expect(relay.filterClientFrame(member(), send(message)).toGateway).toBeDefined();
  });

  it("still sends the chat's own reset through the relay's admin reset, for their own key only", () => {
    const out = relay.filterClientFrame(member(), { type: "req", id: "r", method: "sessions.reset", params: { key: MAIN, reason: "new" } });
    expect(out.reset).toEqual({ id: "r", params: { key: MAIN, reason: "new" } });
    expect(relay.filterClientFrame(member(), { type: "req", id: "r", method: "sessions.reset", params: { key: OLD_MAIN } }).reset).toBeUndefined();
  });
});

// TASK-2520: /new is one of the two commands a member of staff may send, and
// the core refuses it as a chat message from a socket without operator.admin.
// The relay runs it as the reset of their OWN agent's session; what the staff
// policy refuses stays refused, before any reset.
describe("a member of staff's typed /new", () => {
  it.each([MAIN, TAB])("is run as a reset of their own session on their own agent (%s)", (sessionKey) => {
    const out = relay.filterClientFrame(member(), send(" /new ", { sessionKey, deliver: true, toolBindings: [{ tool: "exec" }] }));
    expect(out).toEqual({
      reset: { id: "s1", params: { key: sessionKey, reason: "new" }, chat: { notice: { runId: "k1", sessionKey, action: "new" } } },
    });
  });

  it("is refused on their old key on the owner's agent, and on another member's agent", () => {
    for (const sessionKey of [OLD_MAIN, "agent:clawbox-staff-bob:clawbox-user-alice", "agent:main:main"]) {
      const out = relay.filterClientFrame(member(), send("/new", { sessionKey }));
      expect(out.reset).toBeUndefined();
      expect(refused(out)).toMatch(/someone else/);
    }
  });

  it.each([
    ["/new gpt-5", "/new <model>"],
    ["/new: gpt-5", "/new <model>"],
    ["/new hello there", "/new <model>"],
    ["/reset", "/reset"],
    ["/reset hello", "/reset"],
    ["/reset soft", "/reset"],
  ])("still refuses %j, and resets nothing for it", (message, command) => {
    const out = relay.filterClientFrame(member(), send(message));
    expect(out.reset).toBeUndefined();
    expect(refused(out)).toContain(command);
  });

  it("is refused, and resets nothing, while their agent is not configured with the staff policy", () => {
    const out = relay.filterClientFrame(member(false), send("/new"));
    expect(out.reset).toBeUndefined();
    expect(refused(out)).toMatch(/being set up/);
  });

  it("is refused when the request names another agent", () => {
    const out = relay.filterClientFrame(member(), send("/new", { agentId: "main" }));
    expect(out.reset).toBeUndefined();
    expect(refused(out)).toMatch(/someone else/);
  });
});

describe("a member of staff's session settings", () => {
  it("carry the thinking level and drop the model the chat sends beside it", () => {
    const out = relay.filterClientFrame(member(), { type: "req", id: "p", method: "sessions.patch", params: { key: MAIN, thinkingLevel: "high", model: "clawai/pro" } });
    expect(out.toGateway).toEqual({ type: "req", id: "p", method: "sessions.patch", params: { key: MAIN, thinkingLevel: "high" } });
  });

  it.each([
    [{ model: "openai/gpt-5" }],
    [{ toolOverrides: { allow: ["exec"] } }],
    [{ elevatedLevel: "full" }],
    [{ fastMode: true, contextWindow: 1_000_000 }],
  ])("refuse %j on its own", (patch) => {
    expect(refused(relay.filterClientFrame(member(), { type: "req", id: "p", method: "sessions.patch", params: { key: MAIN, ...patch } }))).toMatch(/administrator/);
  });
});

describe("the command catalogue a member of staff is shown", () => {
  it("is asked of their own agent and cut to /new and /reasoning", () => {
    const state = member();
    const out = relay.filterClientFrame(state, { type: "req", id: "l", method: "commands.list", params: { scope: "text", includeArgs: true } });
    expect(out.toGateway).toEqual({ type: "req", id: "l", method: "commands.list", params: { scope: "text", includeArgs: true, agentId: STAFF } });
    const answer = relay.filterGatewayFrame(state, {
      type: "res", id: "l", ok: true,
      payload: { commands: [{ name: "new" }, { name: "model" }, { name: "reasoning" }, { name: "config" }, { name: "restart" }, { name: "bash" }] },
    });
    expect((answer.toClient as { payload: { commands: Array<{ name: string }> } }).payload.commands.map((c) => c.name)).toEqual(["new", "reasoning"]);
  });
});

describe("staffReadyReader", () => {
  it("answers from openclaw.json and follows it as it changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-staff-"));
    const file = path.join(dir, "openclaw.json");
    const ready = relay.staffReadyReader(file, STAFF);
    expect(ready()).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ agents: { entries: { main: {} } } }));
    expect(ready()).toBe(false);
    const roster = { agents: { entries: { main: {}, [STAFF]: staffAgentEntry(dir, "alice") } } };
    fs.writeFileSync(file, JSON.stringify(roster));
    // A new mtime, even on a fast filesystem.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    // The agent is there, but not the staff guard: not ready.
    expect(ready()).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ ...roster, plugins: { entries: { "clawbox-staff-guard": { enabled: true } } } }));
    fs.utimesSync(file, new Date(Date.now() + 7_000), new Date(Date.now() + 7_000));
    expect(ready()).toBe(false); // enabled, but its files are not installed
    fs.mkdirSync(path.join(dir, "extensions", "clawbox-staff-guard"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions", "clawbox-staff-guard", "index.mjs"), "export default {}\n");
    expect(ready()).toBe(true);
    fs.writeFileSync(file, "{ not json");
    fs.utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(ready()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
