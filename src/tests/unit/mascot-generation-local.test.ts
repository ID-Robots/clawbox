// Local-only phrase generation: the llama.cpp transport, its runtime
// lifecycle, and the gates that keep it from ever competing with the user.
//
// On beta none of this exists — generation targeted Ollama, which is not
// installed on a shipped ClawBox, so `pickOllamaModel` failed on every box and
// the mascot never had a generated phrase in its life.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const runtime = {
  activeRequests: 0,
  ensureCalls: [] as string[],
  begin: [] as string[],
  end: [] as string[],
  ensureThrows: null as Error | null,
};

vi.mock("@/lib/local-ai-runtime", () => ({
  ensureLocalAiReady: vi.fn(async (provider: string) => {
    runtime.ensureCalls.push(provider);
    if (runtime.ensureThrows) throw runtime.ensureThrows;
  }),
  beginLocalAiUse: vi.fn((provider: string) => {
    runtime.begin.push(provider);
    runtime.activeRequests += 1;
  }),
  endLocalAiUse: vi.fn((provider: string) => {
    runtime.end.push(provider);
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
  }),
  getLocalAiRuntimeSnapshot: vi.fn(() => ({ activeRequests: runtime.activeRequests })),
}));

vi.mock("@/lib/llamacpp", () => ({
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8080/v1",
  getDefaultLlamaCppModel: () => "gemma4-e2b-it-q4_0",
}));

import {
  buildRequestBody,
  generatePhrasesLocally,
  parsePhrasePayload,
} from "@/lib/mascot-generation-local";

/** An OpenAI-shaped completion carrying `content` as the assistant message. */
function completion(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const GOOD_BATCH = {
  sass: ["Ich mache hier alles. 🦀", "Schneller, der deploy wartet.", "Bug? Feature. 🫡", "Ich will mehr Lohn."],
  idle: ["*starrt*", "🤔", "*zählt Pixel*", "…"],
  power: ["⚡ ALLMACHT!", "🔥 SUPERZANGE!", "👑 KNIET NIEDER!", "💪 MAXIMALKRAFT!"],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  runtime.activeRequests = 0;
  runtime.ensureCalls = [];
  runtime.begin = [];
  runtime.end = [];
  runtime.ensureThrows = null;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request body", () => {
  it("disables thinking — it costs 8.4s/253 tokens for nothing here", () => {
    const body = buildRequestBody("hello");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("constrains the answer to the phrase-set schema", () => {
    const body = buildRequestBody("hello") as {
      response_format: { type: string; json_schema: { schema: { required: string[] } } };
    };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.required).toContain("nameGreetings");
    expect(body.response_format.json_schema.schema.required).toContain("power");
  });

  it("does not stream — the caller wants one object, not a token feed", () => {
    expect(buildRequestBody("hello").stream).toBe(false);
  });
});

describe("runtime lifecycle", () => {
  it("posts to the llama.cpp chat endpoint with the thinking switch off", async () => {
    fetchMock.mockResolvedValue(completion(JSON.stringify(GOOD_BATCH)));

    const outcome = await generatePhrasesLocally({ prompt: "p", locale: "de" });

    expect(outcome.status).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(runtime.ensureCalls).toEqual(["llamacpp"]);
  });

  it("releases the runtime when the completion throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const outcome = await generatePhrasesLocally({ prompt: "p", locale: "de" });

    expect(outcome).toEqual({ status: "failed", failure: "transport" });
    // The whole point: a failed run must not pin activeRequests above zero,
    // which would block every future refresh AND stop the idle timer from
    // ever unloading a 3.2GB model from an 8GB box.
    expect(runtime.begin).toEqual(["llamacpp"]);
    expect(runtime.end).toEqual(["llamacpp"]);
    expect(runtime.activeRequests).toBe(0);
  });

  it("releases the runtime on the happy path too", async () => {
    fetchMock.mockResolvedValue(completion(JSON.stringify(GOOD_BATCH)));
    await generatePhrasesLocally({ prompt: "p", locale: "de" });
    expect(runtime.activeRequests).toBe(0);
    expect(runtime.end).toEqual(["llamacpp"]);
  });

  it("never claims the runtime when the model could not be started", async () => {
    runtime.ensureThrows = new Error("Local AI is turned off on this device.");

    const outcome = await generatePhrasesLocally({ prompt: "p", locale: "de" });

    expect(outcome).toEqual({ status: "failed", failure: "unavailable" });
    expect(runtime.begin).toEqual([]);
    expect(runtime.end).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("idle gate", () => {
  it("defers while the user's own chat is using the model", async () => {
    runtime.activeRequests = 1;

    const outcome = await generatePhrasesLocally({ prompt: "p", locale: "de" });

    expect(outcome).toEqual({ status: "deferred", reason: "busy" });
    expect(fetchMock).not.toHaveBeenCalled();
    // A busy box is not a broken one — nothing here may arm the backoff.
    expect(runtime.ensureCalls).toEqual([]);
  });

  it("defers when a chat turn lands while the model was starting", async () => {
    // Starting llama.cpp takes tens of seconds; the user can easily send a
    // message in that window, and their turn must win.
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");
    vi.mocked(ensureLocalAiReady).mockImplementationOnce(async () => {
      runtime.activeRequests = 1;
    });

    const outcome = await generatePhrasesLocally({ prompt: "p", locale: "de" });

    expect(outcome).toEqual({ status: "deferred", reason: "busy" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.begin).toEqual([]);
  });
});

describe("failure classification", () => {
  it("calls an HTTP error a transport failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await generatePhrasesLocally({ prompt: "p", locale: "de" })).toEqual({
      status: "failed",
      failure: "transport",
    });
  });

  it("distinguishes our own timeout from a socket error", async () => {
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      }),
    );

    const outcome = await generatePhrasesLocally({ prompt: "p", locale: "de", timeoutMs: 5 });

    // Both surface as AbortError; only the flag we set tells them apart, and
    // they get different backoffs.
    expect(outcome).toEqual({ status: "failed", failure: "timeout" });
    expect(runtime.activeRequests).toBe(0);
  });

  it("calls an unparseable answer malformed", async () => {
    fetchMock.mockResolvedValue(completion("I'm sorry, I can't help with that."));
    expect(await generatePhrasesLocally({ prompt: "p", locale: "de" })).toEqual({
      status: "failed",
      failure: "malformed",
    });
  });

  it("calls a completion with no assistant content malformed", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [] }) });
    expect(await generatePhrasesLocally({ prompt: "p", locale: "de" })).toEqual({
      status: "failed",
      failure: "malformed",
    });
  });

  it("calls a JSON object with none of our categories malformed", async () => {
    fetchMock.mockResolvedValue(completion(JSON.stringify({ answer: "42" })));
    expect(await generatePhrasesLocally({ prompt: "p", locale: "de" })).toEqual({
      status: "failed",
      failure: "malformed",
    });
  });
});

describe("parsing", () => {
  it("accepts a bare object", () => {
    expect(parsePhrasePayload(JSON.stringify(GOOD_BATCH))?.sass).toEqual(GOOD_BATCH.sass);
  });

  it("survives a model that fenced its JSON anyway", () => {
    const fenced = "```json\n" + JSON.stringify(GOOD_BATCH) + "\n```";
    expect(parsePhrasePayload(fenced)?.power).toEqual(GOOD_BATCH.power);
  });

  it("keeps only the known categories", () => {
    const parsed = parsePhrasePayload(JSON.stringify({ ...GOOD_BATCH, nonsense: ["x"] }));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).not.toContain("nonsense");
  });

  it("rejects an array, a string and junk", () => {
    expect(parsePhrasePayload("[]")).toBeNull();
    expect(parsePhrasePayload('"hello"')).toBeNull();
    expect(parsePhrasePayload("not json at all")).toBeNull();
    expect(parsePhrasePayload("")).toBeNull();
  });
});
