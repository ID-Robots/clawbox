import { beforeEach, describe, expect, it, vi } from "vitest";
import { HermesAdapter, type HermesTurnContext } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor } from "@/lib/harness/capabilities";
import { HarnessError } from "@/lib/harness/transport";

/**
 * The Hermes adapter, covering the behaviour that already shipped:
 *
 *  - a turn is one HTTP call threaded by the session id the box echoes back;
 *  - "new chat" forgets that id, which is the only reset this harness can have
 *    and every bit as real as the gateway's;
 *  - the mid-conversation provider switch announces itself, because a resumed
 *    session keeps the system prompt it was created with;
 *  - Stop aborts the request, which is what kills the child process.
 *
 * The three refs behind all of this used to live in a 4000-line component,
 * which is why the reset was a component-level patch reaching into transport
 * state. Here it is a method, and these are its unit tests.
 */

const caps = capabilitiesFor("hermes", { hasClawaiToken: true, hermesSupportsImages: false });

function makeAdapter(
  respond: (body: Record<string, unknown>) => { ok: boolean; status: number; payload: unknown },
  context: HermesTurnContext = { devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true },
) {
  const calls: Array<{ body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ body, signal: init?.signal as AbortSignal | null });
    if (init?.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const answer = respond(body);
    return {
      ok: answer.ok,
      status: answer.status,
      json: async () => answer.payload,
    } as unknown as Response;
  });
  const adapter = new HermesAdapter(caps, () => context, fetchImpl as unknown as typeof fetch);
  return { adapter, calls, fetchImpl };
}

const ok = (payload: unknown) => () => ({ ok: true, status: 200, payload });

describe("HermesAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports itself connected without opening anything", async () => {
    const { adapter } = makeAdapter(ok({ text: "hi" }));
    const seen: string[] = [];
    adapter.onStatus((s) => seen.push(s));
    await adapter.connect();
    expect(seen).toEqual(["connected"]);
    // ...and says out loud that there is nothing behind it, so the UI knows not
    // to render a connection banner rather than rendering a green one about a
    // wire that does not exist.
    expect(adapter.capabilities.hasLiveConnection).toBe(false);
  });

  it("threads the conversation through the session id the box echoes back", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "one", sessionId: "sess-1" }));
    await adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "a" });
    expect(calls[0].body.sessionId).toBeUndefined();
    await adapter.sendTurn({ text: "and again", attachments: [], idempotencyKey: "b" });
    // Without this, a follow-up like "is it removed now?" reaches an agent with
    // no idea what "it" is.
    expect(calls[1].body.sessionId).toBe("sess-1");
  });

  it("makes the agent forget when a new chat starts", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "one", sessionId: "sess-1" }));
    await adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "a" });
    await adapter.resetSession();
    await adapter.sendTurn({ text: "fresh", attachments: [], idempotencyKey: "b" });
    // No resume means the box opens a brand-new session: the reset is real, not
    // a blanked view over an agent that still remembers.
    expect(calls[1].body.sessionId).toBeUndefined();
  });

  it("is idempotent, because the new-chat button is double-clickable", async () => {
    const { adapter } = makeAdapter(ok({ text: "one", sessionId: "sess-1" }));
    await adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "a" });
    await expect(adapter.resetSession()).resolves.toBeUndefined();
    await expect(adapter.resetSession()).resolves.toBeUndefined();
    expect(adapter.threadedSessionId).toBe("");
  });

  it("announces a mid-conversation switch, and only a real one", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok", sessionId: "sess-1" }));
    await adapter.sendTurn({
      text: "first", attachments: [], idempotencyKey: "a", provider: "clawai", model: "deepseek",
    });
    // Same pairing: nothing to announce, so the turn carries no extra text.
    await adapter.sendTurn({
      text: "second", attachments: [], idempotencyKey: "b", provider: "clawai", model: "deepseek",
    });
    expect(calls[1].body.message).toBe("second");
    // Changed pairing on a RESUMED session: the agent still holds the old
    // system prompt and would answer "what model are you?" with the old one.
    await adapter.sendTurn({
      text: "third", attachments: [], idempotencyKey: "c", provider: "openai", model: "gpt-5",
    });
    expect(String(calls[2].body.message)).toContain("System note");
    expect(String(calls[2].body.message)).toContain("third");
  });

  it("does not announce a switch on the first turn of a fresh session", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok", sessionId: "sess-1" }));
    await adapter.sendTurn({
      text: "first", attachments: [], idempotencyKey: "a", provider: "openai", model: "gpt-5",
    });
    // A fresh session already gets a correct system prompt; announcing would be
    // telling the agent about a change that never happened to it.
    expect(calls[0].body.message).toBe("first");
  });

  it("refuses a provider it cannot name a model for, before burning a turn", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok" }), {
      devicePairing: { provider: "clawai", model: "deepseek" },
      modelsReady: true,
    });
    // Sending a provider with no model makes the box fall back to the CONFIGURED
    // provider's default — i.e. this provider run against another one's model id.
    const err = await adapter
      .sendTurn({ text: "x", attachments: [], idempotencyKey: "a", provider: "anthropic" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe("invalid-input");
    expect((err as HarnessError).message).toMatch(/No models are available/);
    expect(calls).toHaveLength(0);
  });

  it("says it is still loading rather than blaming the provider", async () => {
    const { adapter } = makeAdapter(ok({ text: "ok" }), {
      devicePairing: { provider: "clawai", model: "deepseek" },
      modelsReady: false,
    });
    const err = await adapter
      .sendTurn({ text: "x", attachments: [], idempotencyKey: "a", provider: "anthropic" })
      .catch((e) => e);
    expect((err as HarnessError).message).toMatch(/Still loading/);
  });

  it("sends the device's own provider without a model, which is always legal", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok" }));
    await adapter.sendTurn({ text: "x", attachments: [], idempotencyKey: "a", provider: "clawai" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.model).toBeUndefined();
  });

  it("omits an unknown reasoning level rather than guessing one", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok" }));
    await adapter.sendTurn({ text: "x", attachments: [], idempotencyKey: "a", reasoning: "" });
    // A guessed level would silently override the device's own configured
    // effort with whatever the picker happened to be showing.
    expect(calls[0].body.reasoning).toBeUndefined();
    await adapter.sendTurn({ text: "y", attachments: [], idempotencyKey: "b", reasoning: "high" });
    expect(calls[1].body.reasoning).toBe("high");
  });

  it("splits a picture out of the reply the same way the gateway path does", async () => {
    const { adapter } = makeAdapter(
      ok({ text: "Here you go.\nMEDIA:/home/clawbox/clawbox/data/chat-media/x.png" }),
    );
    const result = await adapter.sendTurn({ text: "draw", attachments: [], idempotencyKey: "a" });
    expect(result.text).toBe("Here you go.");
    expect(result.media?.length).toBe(1);
    // The whole reply landed, so nothing else is coming.
    expect(result.acknowledgedOnly).toBeFalsy();
  });

  it("turns a Stop into an aborted error, not a red banner", async () => {
    const { adapter } = makeAdapter(ok({ text: "slow" }));
    const caller = new AbortController();
    caller.abort();
    const err = await adapter
      .sendTurn({ text: "x", attachments: [], idempotencyKey: "a", signal: caller.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe("aborted");
  });

  it("aborts the in-flight turn when Stop is pressed on the adapter", async () => {
    let seen: AbortSignal | null = null;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = (init?.signal as AbortSignal) ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const adapter = new HermesAdapter(
      caps,
      () => ({ devicePairing: { provider: "clawai", model: "d" }, modelsReady: true }),
      fetchImpl as unknown as typeof fetch,
    );
    const turn = adapter.sendTurn({ text: "x", attachments: [], idempotencyKey: "a" });
    const settled = turn.catch((e) => e);
    await adapter.abortTurn();
    expect((await settled as HarnessError).code).toBe("aborted");
    expect(seen).not.toBeNull();
  });

  it("resolves rather than throwing when Stop is pressed with nothing running", async () => {
    const { adapter } = makeAdapter(ok({ text: "ok" }));
    await expect(adapter.abortTurn()).resolves.toBeUndefined();
  });

  it("passes the box's own words through when a turn fails", async () => {
    const { adapter } = makeAdapter(() => ({
      ok: false,
      status: 502,
      payload: { error: "The model provider refused the request." },
    }));
    const err = await adapter
      .sendTurn({ text: "x", attachments: [], idempotencyKey: "a" })
      .catch((e) => e);
    expect((err as HarnessError).code).toBe("upstream");
    expect((err as HarnessError).message).toBe("The model provider refused the request.");
  });

  it("refuses the calls its capabilities say it cannot make", async () => {
    const { adapter } = makeAdapter(ok({ text: "ok" }));
    // A capability that reports false and a method that silently no-ops is how
    // a customer ends up wondering why a button did nothing.
    expect(adapter.capabilities.canListHistory).toBe(false);
    await expect(adapter.loadHistory()).rejects.toMatchObject({ code: "unsupported" });
    expect(adapter.capabilities.canPatchSessionDefaults).toBe(false);
    await expect(adapter.patchSessionDefaults({})).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports a Stop that lands while the body is still being read", async () => {
    // The window the defensive body read opened. `readJsonBody` answers `{}`
    // for anything it cannot parse, and an abort mid-read looks exactly like
    // that — so without a check afterwards the turn would resolve as a
    // SUCCESSFUL reply with no text, and the transcript would show the agent
    // answering nothing instead of the run ending where the user stopped it.
    // A holder, because the response body has to reach back into the adapter
    // that is asking for it — the Stop happens DURING the read.
    const held: { adapter?: HermesAdapter } = {};
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        // Stop pressed after the headers, before the body parses.
        void held.adapter?.abortTurn();
        throw new Error("The user aborted a request.");
      },
    }) as unknown as Response);
    const adapter = new HermesAdapter(
      caps,
      () => ({ devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true }),
      fetchImpl as unknown as typeof fetch,
    );
    held.adapter = adapter;

    await expect(
      adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "a" }),
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
