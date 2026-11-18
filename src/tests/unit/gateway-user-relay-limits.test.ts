import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2446 — the user-chat relay (scripts/gateway-user-relay.js) holds every
 * ClawBox user who is not the owner to the owner's chat limits on OpenClaw:
 * each `chat.send` of theirs is counted (production-server.js hands the relay
 * `admitChat`), and one past the limit is answered by the relay itself with a
 * RATE_LIMITED refusal — it never reaches the gateway, so no model runs. A
 * bare /new or /reset is not a turn and is not counted; a conversation that
 * is not theirs is refused before anything is counted.
 */

const requireCjs = createRequire(import.meta.url);
const relay = requireCjs("../../../scripts/gateway-user-relay.js") as {
  createRelayState(username: string, options?: Record<string, unknown>): Record<string, unknown> & { connected: boolean; connectId: string | null };
  filterClientFrame(state: unknown, frame: unknown): {
    toGateway?: Record<string, unknown>;
    toClient?: Record<string, unknown> & { ok?: boolean; error?: { code: string; message: string; retryAfterMs?: number } };
    reset?: Record<string, unknown>;
  };
};
const limits = requireCjs("../../../scripts/user-limits.js") as typeof import("../../../scripts/user-limits.js");

const ALICE_MAIN = "agent:main:clawbox-user-alice";

function stateWith(admitChat: (() => unknown) | null) {
  const state = relay.createRelayState("alice", admitChat ? { admitChat } : {});
  state.connected = true;
  state.connectId = "c1";
  return state;
}

const send = (id: string, message: string, sessionKey = ALICE_MAIN) => ({
  type: "req",
  id,
  method: "chat.send",
  params: { sessionKey, message, deliver: false, idempotencyKey: `k-${id}` },
});

afterEach(() => limits.forgetChatRequests());

describe("chat limits on the relay", () => {
  it("passes an admitted turn on to the gateway, counting it", () => {
    const admit = vi.fn(() => ({ ok: true }));
    const out = relay.filterClientFrame(stateWith(admit), send("s1", "hello"));
    expect(out.toGateway).toBeDefined();
    expect(out.toClient).toBeUndefined();
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("answers a turn past the limit itself, with the wait, and sends nothing to the gateway", () => {
    const admit = vi.fn(() => ({ ok: false, window: "minute", limit: 2, retryAfterSeconds: 42 }));
    const out = relay.filterClientFrame(stateWith(admit), send("s2", "hello"));
    expect(out.toGateway).toBeUndefined();
    expect(out.toClient).toEqual({
      type: "res",
      id: "s2",
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "You have reached your chat limit on this ClawBox: 2 messages a minute. Try again in 42 seconds.",
        retryAfterMs: 42_000,
      },
    });
  });

  it("does not count a bare /new or /reset, but does count one that carries a message", () => {
    const admit = vi.fn(() => ({ ok: true }));
    const state = stateWith(admit);
    expect(relay.filterClientFrame(state, send("n1", "/new")).reset).toBeDefined();
    expect(relay.filterClientFrame(state, send("n2", "/reset")).reset).toBeDefined();
    expect(admit).not.toHaveBeenCalled();
    relay.filterClientFrame(state, send("n3", "/new what is on today?"));
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("counts only turns: reading history or stopping a turn is never limited", () => {
    const admit = vi.fn(() => ({ ok: false, window: "hour", limit: 1, retryAfterSeconds: 60 }));
    const state = stateWith(admit);
    expect(relay.filterClientFrame(state, { type: "req", id: "h1", method: "chat.history", params: { sessionKey: ALICE_MAIN } }).toGateway).toBeDefined();
    expect(relay.filterClientFrame(state, { type: "req", id: "a1", method: "chat.abort", params: { sessionKey: ALICE_MAIN } }).toGateway).toBeDefined();
    expect(admit).not.toHaveBeenCalled();
  });

  it("refuses someone else's conversation before counting anything", () => {
    const admit = vi.fn(() => ({ ok: true }));
    const out = relay.filterClientFrame(stateWith(admit), send("x1", "hi", "agent:main:clawbox-user-bob"));
    expect(out.toClient?.error?.code).toBe("FORBIDDEN");
    expect(admit).not.toHaveBeenCalled();
  });

  it("counts nothing on a relay given no limits", () => {
    for (let i = 0; i < 50; i++) expect(relay.filterClientFrame(stateWith(null), send(`f${i}`, "hi")).toGateway).toBeDefined();
  });

  it("holds a user to the owner's limit with the box's own counter, as production-server.js wires it", () => {
    const state = stateWith(() => limits.admitChatRequest("alice", { chatPerMinute: 2, chatPerHour: 0 }));
    expect(relay.filterClientFrame(state, send("r1", "one")).toGateway).toBeDefined();
    expect(relay.filterClientFrame(state, send("r2", "two")).toGateway).toBeDefined();
    const third = relay.filterClientFrame(state, send("r3", "three"));
    expect(third.toGateway).toBeUndefined();
    expect(third.toClient?.error?.code).toBe("RATE_LIMITED");
    expect(third.toClient?.error?.message).toMatch(/^You have reached your chat limit on this ClawBox: 2 messages a minute\. Try again in \d+ seconds?\.$/);
    // Another user's count is their own.
    const bob = relay.createRelayState("bob", { admitChat: () => limits.admitChatRequest("bob", { chatPerMinute: 2, chatPerHour: 0 }) });
    bob.connected = true;
    expect(relay.filterClientFrame(bob, send("b1", "hi", "agent:main:clawbox-user-bob")).toGateway).toBeDefined();
  });
});
