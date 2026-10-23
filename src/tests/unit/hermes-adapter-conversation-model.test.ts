import { describe, expect, it, vi } from "vitest";
import { HermesAdapter, type HermesTurnContext } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";

/**
 * `HermesAdapter.conversationModel` — the model the conversation on a session
 * key goes on answering with, which the chat compares with its header to say
 * "This chat keeps its model; start a new chat to use the new model."
 *
 * From Hermes v0.22.4 a resumed session keeps its frozen launch: the route
 * resumes without `-m`/`--provider`, the session's own model answers, and the
 * turn records no model at all. A pick made mid-conversation therefore applies
 * to the next new chat. The answer is null whenever the next turn would open a
 * fresh session instead, because then the header's model WILL answer.
 */

const caps = capabilitiesFor("hermes", UNKNOWN_FACTS);
const SESSION_A = "20260810_221825_609d1e";
const SESSION_B = "20260810_221900_7a8b9c";

type Answer = { ok: boolean; status: number; payload: unknown };

function makeAdapter(respond: (body: Record<string, unknown>) => Answer) {
  const context: HermesTurnContext = {
    devicePairing: { provider: "anthropic", model: "claude-fable-5" },
    modelsReady: true,
    sessionKey: "desktop",
  };
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    // The transcript DELETE a reset makes carries no body and needs no answer.
    if (init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    bodies.push(body);
    const answer = respond(body);
    return { ok: answer.ok, status: answer.status, json: async () => answer.payload } as unknown as Response;
  });
  const adapter = new HermesAdapter(caps, () => context, fetchImpl as unknown as typeof fetch);
  return { adapter, bodies, context };
}

const turn = (model: string, provider = "anthropic") => ({
  text: "hi",
  attachments: [],
  idempotencyKey: `turn-${model}`,
  model,
  provider,
});

const answer = (payload: Record<string, unknown>): Answer => ({ ok: true, status: 200, payload: { text: "ok", ...payload } });

describe("HermesAdapter.conversationModel", () => {
  it("holds nothing before the conversation's first reply", () => {
    const { adapter } = makeAdapter(() => answer({}));
    expect(adapter.conversationModel("desktop")).toBeNull();
  });

  it("holds the model the session's first turn recorded", async () => {
    const { adapter } = makeAdapter(() => answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" }));
    await adapter.sendTurn(turn("claude-fable-5"));
    expect(adapter.conversationModel("desktop")).toEqual({ model: "claude-fable-5", provider: "anthropic" });
  });

  it("keeps it across a resumed turn that recorded nothing, whatever that turn asked for", async () => {
    // The v0.22.4 CLI resume: no `-m` on argv, the session's own route answers,
    // and the reply names no model.
    let first = true;
    const { adapter, bodies } = makeAdapter(() => {
      if (first) {
        first = false;
        return answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" });
      }
      return answer({ sessionId: SESSION_A });
    });
    await adapter.sendTurn(turn("claude-fable-5"));
    await adapter.sendTurn(turn("claude-sonnet-5"));
    expect(bodies[1]).toMatchObject({ sessionId: SESSION_A, model: "claude-sonnet-5" });
    expect(adapter.conversationModel("desktop")).toEqual({ model: "claude-fable-5", provider: "anthropic" });
  });

  it("follows a resumed turn that recorded a different model — the switch took", async () => {
    let first = true;
    const { adapter } = makeAdapter(() => {
      if (first) {
        first = false;
        return answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" });
      }
      return answer({ sessionId: SESSION_A, model: "claude-sonnet-5" });
    });
    await adapter.sendTurn(turn("claude-fable-5"));
    await adapter.sendTurn(turn("claude-sonnet-5"));
    expect(adapter.conversationModel("desktop")).toEqual({ model: "claude-sonnet-5" });
  });

  it("claims nothing for a session that opened without recording a model", async () => {
    const { adapter } = makeAdapter(() => answer({ sessionId: SESSION_A }));
    await adapter.sendTurn(turn("claude-fable-5"));
    expect(adapter.conversationModel("desktop")).toBeNull();
  });

  it("claims nothing when the box handed back no session to resume", async () => {
    // The next turn opens a fresh session, which runs on whatever the header sends.
    const { adapter } = makeAdapter(() => answer({ model: "claude-fable-5", provider: "anthropic" }));
    await adapter.sendTurn(turn("claude-fable-5"));
    expect(adapter.conversationModel("desktop")).toBeNull();
  });

  it("drops the old session's model when a turn comes back on a NEW session that recorded none", async () => {
    let first = true;
    const { adapter } = makeAdapter(() => {
      if (first) {
        first = false;
        return answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" });
      }
      return answer({ sessionId: SESSION_B });
    });
    await adapter.sendTurn(turn("claude-fable-5"));
    await adapter.sendTurn(turn("claude-sonnet-5"));
    expect(adapter.conversationModel("desktop")).toBeNull();
  });

  it("leaves the record alone when a turn fails", async () => {
    let first = true;
    const { adapter } = makeAdapter(() => {
      if (first) {
        first = false;
        return answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" });
      }
      return { ok: false, status: 502, payload: { error: "Hermes chat failed" } };
    });
    await adapter.sendTurn(turn("claude-fable-5"));
    await expect(adapter.sendTurn(turn("claude-sonnet-5"))).rejects.toThrow();
    expect(adapter.conversationModel("desktop")).toEqual({ model: "claude-fable-5", provider: "anthropic" });
  });

  it("forgets it on a new chat", async () => {
    const { adapter } = makeAdapter(() => answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" }));
    await adapter.sendTurn(turn("claude-fable-5"));
    await adapter.resetSession();
    expect(adapter.conversationModel("desktop")).toBeNull();
  });

  it("keeps one record per conversation, and closing a tab forgets only its own", async () => {
    const { adapter, context } = makeAdapter((body) => (
      body.sessionKey === "desktop"
        ? answer({ sessionId: SESSION_A, model: "claude-fable-5", provider: "anthropic" })
        : answer({ sessionId: SESSION_B, model: "gpt-5.6-sol", provider: "openai" })
    ));
    await adapter.sendTurn(turn("claude-fable-5"));
    context.sessionKey = "desktop-tab1";
    await adapter.sendTurn(turn("gpt-5.6-sol", "openai"));
    expect(adapter.conversationModel("desktop")).toEqual({ model: "claude-fable-5", provider: "anthropic" });
    expect(adapter.conversationModel("desktop-tab1")).toEqual({ model: "gpt-5.6-sol", provider: "openai" });

    await adapter.deleteSession("desktop-tab1", { running: false });
    expect(adapter.conversationModel("desktop-tab1")).toBeNull();
    expect(adapter.conversationModel("desktop")).toEqual({ model: "claude-fable-5", provider: "anthropic" });
  });
});
