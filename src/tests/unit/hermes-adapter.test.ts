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

const caps = capabilitiesFor("hermes", {
  hasClawaiToken: true,
  hermesSupportsImages: true,
  hermesHasVisionRoute: true,
  hermesStreamsTurns: false,
  // A box that can draw: the credential plus a live image route. Both halves,
  // because `imageGenerationTrigger` is what `generateImage` checks first.
  hasClawaiImageRoute: true,
  hermesAgentDrawsImages: false,
});
const CONTEXT: HermesTurnContext = {
  devicePairing: { provider: "clawai", model: "deepseek" },
  modelsReady: true,
  sessionKey: "desktop",
};

function makeAdapter(
  respond: (body: Record<string, unknown>) => { ok: boolean; status: number; payload: unknown },
  context: HermesTurnContext = { devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true, sessionKey: "desktop" },
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

  it("sends the customer's message and nothing else, switch or no switch", async () => {
    // This used to prepend a "[System note: this conversation has just been
    // switched to model X]" paragraph to the customer's own message whenever
    // the pills changed mid-conversation. It was never true: the resume call
    // dropped the override, so nothing had been switched, and the note asked
    // the model to announce a change that had not happened. The model saw
    // straight through it -- "that 'system note' arrived inside your chat
    // message, not from my actual harness" -- and contradicted it.
    //
    // Configuration is not message content. The switch is now made for real on
    // the transport (`/model ... --session` before the prompt is submitted), and
    // the message body is exactly what was typed.
    const { adapter, calls } = makeAdapter(ok({ text: "ok", sessionId: "sess-1" }));
    await adapter.sendTurn({
      text: "first", attachments: [], idempotencyKey: "a", provider: "clawai", model: "deepseek",
    });
    await adapter.sendTurn({
      text: "second", attachments: [], idempotencyKey: "b", provider: "clawai", model: "deepseek",
    });
    expect(calls[1].body.message).toBe("second");
    // The turn that changes the pairing on a RESUMED session -- the one that
    // used to carry the note.
    await adapter.sendTurn({
      text: "third", attachments: [], idempotencyKey: "c", provider: "openai", model: "gpt-5",
    });
    expect(calls[2].body.message).toBe("third");
    expect(String(calls[2].body.message)).not.toContain("System note");
    // The pills still travel -- they are what the route hands the transport.
    expect(calls[2].body.provider).toBe("openai");
    expect(calls[2].body.model).toBe("gpt-5");
  });

  it("sends no displayText, because the message is never rewritten", async () => {
    // `displayText` existed only to keep the injected note out of the
    // transcript. With nothing injected there are no longer two versions of the
    // message to keep apart.
    const { adapter, calls } = makeAdapter(ok({ text: "ok", sessionId: "sess-1" }));
    await adapter.sendTurn({
      text: "first", attachments: [], idempotencyKey: "a", provider: "openai", model: "gpt-5",
    });
    await adapter.sendTurn({
      text: "second", attachments: [], idempotencyKey: "b", provider: "anthropic", model: "claude-fable-5",
    });
    expect(calls[0].body.message).toBe("first");
    expect(calls[0].body).not.toHaveProperty("displayText");
    expect(calls[1].body).not.toHaveProperty("displayText");
  });

  it("refuses a provider it cannot name a model for, before burning a turn", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok" }), {
      devicePairing: { provider: "clawai", model: "deepseek" },
      modelsReady: true,
      sessionKey: "desktop",
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
      sessionKey: "desktop",
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
      () => ({ devicePairing: { provider: "clawai", model: "d" }, modelsReady: true, sessionKey: "desktop" }),
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

  // ── The durable transcript ────────────────────────────────────────────────
  //
  // The refresh bug this fixes: the screen emptied while the agent still
  // remembered the conversation, because the transcript only ever lived in
  // React state.

  it("replays the conversation the box recorded", async () => {
    const rows = [
      { role: "user", text: "what is on my calendar", timestamp: 10 },
      { role: "assistant", text: "Nothing today.", timestamp: 20 },
    ];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: rows }),
    } as unknown as Response));
    const adapter = new HermesAdapter(caps, () => CONTEXT, fetchImpl as unknown as typeof fetch);
    const page = await adapter.loadHistory({ limit: 50 });
    expect(page.messages).toEqual(rows);
    // No image-generation verdict to give: that notice is a gateway artefact
    // with no equivalent here, so claiming one either way would be inventing it.
    expect(page.imageGenerationFailed).toBe(false);
  });

  it("asks for the transcript uncached, so a reset cannot be repainted from a stale 200", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ messages: [] }),
    } as unknown as Response));
    const adapter = new HermesAdapter(caps, () => CONTEXT, fetchImpl as unknown as typeof fetch);
    await adapter.loadHistory({ limit: 25 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/setup-api/chat/history");
    expect(url).toContain("limit=25");
    expect(init.cache).toBe("no-store");
  });

  it("drops a row the surface has no way to render rather than rendering nothing", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          { role: "assistant", text: "kept", timestamp: 1 },
          { role: "wizard", text: "not a role this chat has", timestamp: 2 },
          { role: "user", timestamp: 3 },
          "not an object",
        ],
      }),
    } as unknown as Response));
    const adapter = new HermesAdapter(caps, () => CONTEXT, fetchImpl as unknown as typeof fetch);
    const page = await adapter.loadHistory();
    expect(page.messages).toEqual([{ role: "assistant", text: "kept", timestamp: 1 }]);
  });

  it("reports a transcript it could not read, rather than an empty conversation", async () => {
    // An empty page and an unreadable one look identical on screen, and only
    // one of them means "you have said nothing yet".
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: "disk" }),
    } as unknown as Response));
    const adapter = new HermesAdapter(caps, () => CONTEXT, fetchImpl as unknown as typeof fetch);
    await expect(adapter.loadHistory()).rejects.toBeInstanceOf(HarnessError);
  });

  it("clears the stored transcript as part of starting a new chat", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    });
    const adapter = new HermesAdapter(caps, () => CONTEXT, fetchImpl as unknown as typeof fetch);
    await adapter.resetSession();
    expect(seen).toEqual([{ url: "/setup-api/chat/history?sessionKey=desktop", method: "DELETE" }]);
  });

  it("still forgets the session when the transcript cannot be cleared", async () => {
    // The agent has already forgotten by the time the DELETE goes out — the id
    // is dropped first. Rejecting here would report a failed reset that in fact
    // succeeded, and leave the (+) button looking broken.
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ text: "hi", sessionId: "s2" }) } as unknown as Response;
    });
    const adapter = new HermesAdapter(caps, () => CONTEXT, fetchImpl as unknown as typeof fetch);
    await adapter.sendTurn({ text: "one", attachments: [], idempotencyKey: "k" });
    expect(adapter.threadedSessionId).toBe("s2");
    await expect(adapter.resetSession()).resolves.toBeUndefined();
    expect(adapter.threadedSessionId).toBe("");
  });

  // ── Attachments ───────────────────────────────────────────────────────────

  it("hands the staged image paths to the route, which is what re-checks them", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "a cat", sessionId: "s1" }));
    await adapter.sendTurn({
      text: "what is this",
      attachments: [
        { name: "a.png", path: "/home/clawbox/clawbox/data/chat-media/chat-attachments/a.png", type: "image/png" },
        { name: "b.png", path: "/home/clawbox/clawbox/data/chat-media/chat-attachments/b.png", type: "image/png" },
      ],
      idempotencyKey: "k",
    });
    expect(calls[0].body.imagePaths).toEqual([
      "/home/clawbox/clawbox/data/chat-media/chat-attachments/a.png",
      "/home/clawbox/clawbox/data/chat-media/chat-attachments/b.png",
    ]);
  });

  it("sends no imagePaths field at all on an ordinary turn", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "hi", sessionId: "s1" }));
    await adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "k" });
    expect(calls[0].body).not.toHaveProperty("imagePaths");
    expect(calls[0].body).not.toHaveProperty("displayText");
  });

  it("records the user's own words on a model change, with nothing added", async () => {
    const { adapter, calls } = makeAdapter(ok({ text: "ok", sessionId: "s1" }));
    await adapter.sendTurn({ text: "one", attachments: [], idempotencyKey: "a", provider: "clawai", model: "m1" });
    await adapter.sendTurn({ text: "two", attachments: [], idempotencyKey: "b", provider: "clawai", model: "m2" });
    // What the customer typed is what is sent and what is stored -- one version
    // of the message, not an agent-facing one and a display one.
    expect(calls[1].body.message).toBe("two");
    expect(calls[1].body).not.toHaveProperty("displayText");
  });

  it("refuses the calls its capabilities say it cannot make", async () => {
    const { adapter } = makeAdapter(ok({ text: "ok" }));
    // A capability that reports false and a method that silently no-ops is how
    // a customer ends up wondering why a button did nothing.
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
      () => ({ devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true, sessionKey: "desktop" }),
      fetchImpl as unknown as typeof fetch,
    );
    held.adapter = adapter;

    await expect(
      adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "a" }),
    ).rejects.toMatchObject({ code: "aborted" });
  });
  describe("a second conversation beside the first", () => {
    // The (+) opens a tab, and a tab is a conversation of its own: its turns
    // resume ITS Hermes session, its transcript is ITS file, and closing it
    // forgets exactly that much. The surface tells the adapter which one it is
    // showing through the context's `sessionKey`.
    it("mints a bare-filename key beside main and owns only that shape", () => {
      const { adapter } = makeAdapter(ok({ text: "x" }));
      const key = adapter.newSessionKey("desktop");
      expect(key).toMatch(/^desktop-[a-z0-9]{12}$/);
      expect(adapter.ownsSessionKey(key)).toBe(true);
      expect(adapter.ownsSessionKey("desktop")).toBe(true);
      // A gateway key, restored on a dual box that switched harness.
      expect(adapter.ownsSessionKey("agent:main:clawbox-0123456789ab")).toBe(false);
    });

    it("threads each conversation on its own session id", async () => {
      const context = { devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true, sessionKey: "desktop" };
      const { adapter, calls } = makeAdapter(
        (body) => ({ ok: true, status: 200, payload: { text: "ok", sessionId: body.sessionKey === "desktop" ? "s-main" : "s-tab" } }),
        context,
      );
      await adapter.sendTurn({ text: "one", attachments: [], idempotencyKey: "a" });
      context.sessionKey = "desktop-0123456789ab";
      await adapter.sendTurn({ text: "two", attachments: [], idempotencyKey: "b" });
      await adapter.sendTurn({ text: "three", attachments: [], idempotencyKey: "c" });
      context.sessionKey = "desktop";
      await adapter.sendTurn({ text: "four", attachments: [], idempotencyKey: "d" });
      // The tab's first turn resumes nothing — a fresh session — and every
      // turn names the transcript it is recorded under.
      expect(calls.map((c) => [c.body.sessionKey, c.body.sessionId])).toEqual([
        ["desktop", undefined],
        ["desktop-0123456789ab", undefined],
        ["desktop-0123456789ab", "s-tab"],
        ["desktop", "s-main"],
      ]);
    });

    it("closing a tab forgets its session and deletes its transcript, and nothing else", async () => {
      const context = { devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true, sessionKey: "desktop" };
      const seen: Array<{ url: string; method?: string }> = [];
      const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method });
        return { ok: true, status: 200, json: async () => ({ text: "ok", sessionId: "s1" }) } as unknown as Response;
      });
      const adapter = new HermesAdapter(caps, () => context, fetchImpl as unknown as typeof fetch);
      await adapter.sendTurn({ text: "one", attachments: [], idempotencyKey: "a" });
      context.sessionKey = "desktop-0123456789ab";
      await adapter.sendTurn({ text: "two", attachments: [], idempotencyKey: "b" });
      seen.length = 0;
      await adapter.deleteSession("desktop-0123456789ab", { running: false });
      expect(seen).toEqual([{ url: "/setup-api/chat/history?sessionKey=desktop-0123456789ab", method: "DELETE" }]);
      // Main still remembers its thread.
      context.sessionKey = "desktop";
      expect(adapter.threadedSessionId).toBe("s1");
    });
  });

  describe("generateImage", () => {
    /** An adapter whose images route answers however the test says. */
    function drawing(
      respond: (prompt: string) => { ok: boolean; status: number; payload: unknown },
      capabilities = caps,
    ) {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        const answer = respond(String(body.prompt ?? ""));
        return {
          ok: answer.ok,
          status: answer.status,
          json: async () => answer.payload,
        } as unknown as Response;
      });
      const adapter = new HermesAdapter(
        capabilities,
        () => CONTEXT,
        fetchImpl as unknown as typeof fetch,
      );
      return { adapter, calls };
    }

    it("posts the prompt to the box's images route and returns the media refs", async () => {
      const { adapter, calls } = drawing(() => ({
        ok: true,
        status: 200,
        payload: { ok: true, media: ["/setup-api/chat/media?path=%2Fa.png"] },
      }));
      await expect(adapter.generateImage("a red maple leaf")).resolves.toEqual({
        media: ["/setup-api/chat/media?path=%2Fa.png"],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("/setup-api/chat/images");
      // Recorded under the conversation that asked for it, like a turn.
      expect(calls[0].body).toEqual({ prompt: "a red maple leaf", sessionKey: "desktop" });
    });

    it("refuses outright on a box whose trigger is not the composer", async () => {
      // The precondition this interface states for every method: calling one
      // whose capability is false is a BUG in the caller, and it fails loudly
      // so a test catches it rather than a customer wondering why a button did
      // nothing. Here the box has no image route probed, so there is nowhere
      // for a prompt to go.
      const cannot = capabilitiesFor("hermes", {
        hasClawaiToken: true,
        hermesSupportsImages: true,
        hermesHasVisionRoute: true,
        hermesStreamsTurns: false,
        hasClawaiImageRoute: false,
        hermesAgentDrawsImages: false,
      });
      const { adapter, calls } = drawing(() => ({ ok: true, status: 200, payload: {} }), cannot);
      await expect(adapter.generateImage("x")).rejects.toMatchObject({ code: "unsupported" });
      // And nothing left the browser.
      expect(calls).toHaveLength(0);
    });

    it("maps the route's statuses onto the affordance each one wants", async () => {
      // `not-configured` is "link this box" and gets a different retry
      // affordance from `upstream`, which is "the far side had a bad day".
      // Flattening them would send a customer with an unlinked box to press
      // Retry forever.
      const cases: Array<{ status: number; code: string }> = [
        { status: 503, code: "not-configured" },
        { status: 400, code: "invalid-input" },
        { status: 429, code: "invalid-input" },
        { status: 502, code: "upstream" },
        { status: 500, code: "upstream" },
      ];
      for (const c of cases) {
        const { adapter } = drawing(() => ({
          ok: false,
          status: c.status,
          payload: { error: "the box said no" },
        }));
        await expect(adapter.generateImage("x")).rejects.toMatchObject({
          code: c.code,
          message: "the box said no",
        });
      }
    });

    it("reports a stop as a stop rather than as a failure", async () => {
      // 499 is what the route answers a caller who hung up, and a customer who
      // changed their mind must not be shown a red bubble for it.
      const { adapter } = drawing(() => ({ ok: false, status: 499, payload: {} }));
      await expect(adapter.generateImage("x")).rejects.toMatchObject({ code: "aborted" });
    });

    it("treats a 200 with no picture in it as a failure, not as an empty answer", async () => {
      // Otherwise the wait ends with an empty bubble, which reads as "the box
      // drew nothing" rather than as something having gone wrong.
      for (const payload of [{ ok: true }, { ok: true, media: [] }, { ok: true, media: [""] }]) {
        const { adapter } = drawing(() => ({ ok: true, status: 200, payload }));
        await expect(adapter.generateImage("x")).rejects.toMatchObject({ code: "upstream" });
      }
    });

    it("has its own sentence when the route answered nothing readable", async () => {
      const { adapter } = drawing(() => ({ ok: false, status: 502, payload: null }));
      await expect(adapter.generateImage("x")).rejects.toMatchObject({
        code: "upstream",
        message: "Could not generate the picture.",
      });
    });
  });
});
