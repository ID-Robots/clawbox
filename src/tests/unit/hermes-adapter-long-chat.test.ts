import { describe, expect, it, vi } from "vitest";
import { HermesAdapter, type HermesTurnContext } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";

/**
 * TASK-2127 on Hermes: the chat measures a long conversation before sending it
 * to Local AI (`conversationSize`, the size route over `state.db`) and can
 * shorten it first (`compactConversation`, Hermes' own `/compress` through the
 * chat route). Both work on the Hermes session the conversation is threaded to,
 * and a conversation with none has nothing to measure or shorten.
 */

const caps = capabilitiesFor("hermes", UNKNOWN_FACTS);
const SESSION = "20260810_221825_609d1e";

function makeAdapter(route: (url: string, init?: RequestInit) => { ok: boolean; status: number; payload: unknown }) {
  const context: HermesTurnContext = {
    devicePairing: { provider: "clawlocal", model: "gemma4-e2b-it-q4_0" },
    modelsReady: true,
    sessionKey: "desktop",
  };
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    const answer = route(String(url), init);
    return { ok: answer.ok, status: answer.status, json: async () => answer.payload } as unknown as Response;
  });
  const adapter = new HermesAdapter(caps, () => context, fetchImpl as unknown as typeof fetch);
  return { adapter, calls };
}

/** Thread the conversation to SESSION the way a reply does. */
async function thread(adapter: HermesAdapter) {
  await adapter.sendTurn({ text: "hi", attachments: [], idempotencyKey: "t1", model: "deepseek-v4-pro", provider: "clawai" });
}

describe("HermesAdapter on a long conversation", () => {
  it("measures the threaded session through the size route", async () => {
    const { adapter, calls } = makeAdapter((url) => url.startsWith("/setup-api/hermes/session-size")
      ? { ok: true, status: 200, payload: { tokens: 100460, window: 65536, limit: 32768 } }
      : { ok: true, status: 200, payload: { text: "ok", sessionId: SESSION } });
    expect(await adapter.conversationSize("desktop")).toBeNull();
    expect(calls).toHaveLength(0);

    await thread(adapter);
    await expect(adapter.conversationSize("desktop")).resolves.toEqual({ tokens: 100460, window: 65536, limit: 32768 });
    expect(calls.at(-1)?.url).toBe(`/setup-api/hermes/session-size?sessionId=${SESSION}`);
  });

  it("says nothing for a size it could not get", async () => {
    const { adapter } = makeAdapter((url) => url.startsWith("/setup-api/hermes/session-size")
      ? { ok: true, status: 200, payload: { tokens: null, window: 65536, limit: 32768 } }
      : { ok: true, status: 200, payload: { text: "ok", sessionId: SESSION } });
    await thread(adapter);
    await expect(adapter.conversationSize("desktop")).resolves.toBeNull();
  });

  it("shortens with Hermes' own /compress on the threaded session", async () => {
    const { adapter, calls } = makeAdapter(() => ({ ok: true, status: 200, payload: { text: "Compressed 120 → 14 messages", sessionId: SESSION } }));
    await thread(adapter);
    await expect(adapter.compactConversation("desktop")).resolves.toEqual({});
    expect(calls.at(-1)).toEqual({
      url: "/setup-api/hermes/chat",
      body: { message: "/compress", sessionKey: "desktop", sessionId: SESSION },
    });
  });

  it("rejects a shorten the route refused, and one with no session to shorten", async () => {
    const { adapter } = makeAdapter((_url, init) => (String(init?.body ?? "").includes("/compress")
      ? { ok: false, status: 502, payload: { error: "compression timed out" } }
      : { ok: true, status: 200, payload: { text: "ok", sessionId: SESSION } }));
    await expect(adapter.compactConversation("desktop")).rejects.toThrow(/no session/);
    await thread(adapter);
    await expect(adapter.compactConversation("desktop")).rejects.toThrow("compression timed out");
  });
});
