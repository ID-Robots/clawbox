// Asking Ollama about a model before we register it.
//
// Two registrations used to succeed and then fail forever, one dead chat turn
// at a time: an id Ollama does not have, and — on Hermes — a model whose
// context window is under the agent's 64K floor. `/api/show` answers both, so
// the answer is now taken at save time (TASK-448).
//
// The payload shapes below are Ollama 0.32.9's, from the bench device:
// a missing model answers HTTP 404 `{"error":"model 'x' not found"}`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-ai-runtime", () => ({
  getOllamaBaseUrl: () => "http://127.0.0.1:11434",
}));

import {
  HERMES_MINIMUM_CONTEXT_TOKENS,
  contextLengthFromShow,
  probeOllamaModel,
} from "@/lib/ollama-model-context";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reading a context window out of /api/show", () => {
  it("prefers the Modelfile's num_ctx over the GGUF training maximum", () => {
    // num_ctx is what Ollama allocates KV cache for; the GGUF number is the
    // training max and can be larger. Trusting the larger one would let a
    // conversation grow past the runtime limit, where Ollama silently
    // truncates it — which is why the agent resolves it in this order too.
    const window = contextLengthFromShow({
      parameters: "stop  \"<|im_end|>\"\nnum_ctx  8192\n",
      model_info: { "qwen2.context_length": 32768 },
    });
    expect(window).toBe(8192);
  });

  it("falls back to the architecture-namespaced GGUF context_length", () => {
    expect(contextLengthFromShow({ model_info: { "llama.context_length": 131072 } })).toBe(131072);
  });

  it("ignores a model_info key that merely mentions context length", () => {
    // Suffix match, not substring: "…context_length_scale" is a different
    // number and reading it as the window would refuse good models.
    expect(
      contextLengthFromShow({ model_info: { "llama.rope.context_length_scale": 4 } }),
    ).toBeNull();
  });

  it("answers null when there is nothing to read", () => {
    expect(contextLengthFromShow({})).toBeNull();
    expect(contextLengthFromShow(null)).toBeNull();
    expect(contextLengthFromShow("not an object")).toBeNull();
    expect(contextLengthFromShow({ parameters: "num_ctx  nonsense" })).toBeNull();
    expect(contextLengthFromShow({ model_info: { "x.context_length": 0 } })).toBeNull();
  });
});

describe("probing a model", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the local Ollama by model id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ model_info: { "qwen2.context_length": 32768 } }));

    const probe = await probeOllamaModel("qwen2.5:3b");

    expect(probe).toEqual({ status: "ok", contextLength: 32768 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/show");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ model: "qwen2.5:3b" });
  });

  it("reports a 404 as not installed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "model 'ghost:7b' not found" }, 404));
    expect(await probeOllamaModel("ghost:7b")).toEqual({ status: "not-installed" });
  });

  it("reports an empty id as not installed without asking", async () => {
    expect(await probeOllamaModel("   ")).toEqual({ status: "not-installed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says unreachable — never 'not installed' — when Ollama cannot answer", async () => {
    // The distinction decides whether a save is refused. A refused save on a
    // sleeping runtime would be a fabricated verdict about the model.
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await probeOllamaModel("qwen2.5:3b")).toEqual({ status: "unreachable" });

    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    expect(await probeOllamaModel("qwen2.5:3b")).toEqual({ status: "unreachable" });
  });

  it("treats an unparseable 200 as installed with an unknown window", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await probeOllamaModel("qwen2.5:3b")).toEqual({ status: "ok", contextLength: null });
  });

  it("pins the agent's floor", () => {
    // agent/model_metadata.py: MINIMUM_CONTEXT_LENGTH = 64_000, enforced in
    // agent_init. If Hermes moves it, this number moves with it.
    expect(HERMES_MINIMUM_CONTEXT_TOKENS).toBe(64_000);
  });
});
