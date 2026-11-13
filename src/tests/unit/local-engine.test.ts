/**
 * src/lib/local-engine.ts — the box's own engine as a model ClawBox's features
 * ask from the server (TASK-2501 PR-C).
 *
 * Pinned: which engine holds the Local AI slot (the External engine first,
 * then llama.cpp or Ollama only while Local AI is on), where its requests go
 * (the Local AI proxy for the on-box runtimes, with the per-install bearer;
 * the owner's server with its own key), the window each one is sized by
 * (ClawBox's Ollama default unless the model sets its own), what the request
 * says about thinking, and which engines can look at a picture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown>, key: null as string | null }));
vi.mock("@/lib/config-store", () => ({
  getAll: async () => state.value,
  get: async (key: string) => state.value[key],
  resolveConfigRoot: () => "/nonexistent",
}));
vi.mock("@/lib/external-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/external-engine")>()),
  readExternalEngineKey: () => state.key,
}));

const alias = vi.fn(async (): Promise<string | null> => "gemma4-e2b-it-q4_0");
vi.mock("@/lib/llamacpp-server", () => ({ resolveConfiguredLlamaCppAlias: () => alias() }));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-install-token" }));

const show = vi.fn(async (): Promise<{ status: "ok"; payload: unknown } | { status: "unreachable" } | { status: "not-installed" }> => ({ status: "ok", payload: {} }));
vi.mock("@/lib/ollama-capabilities", () => ({ fetchOllamaShow: () => show() }));

import {
  OLLAMA_DEFAULT_CONTEXT_TOKENS,
  isLocalEngineRef,
  localEngineSeesPictures,
  postLocalChat,
  resolveLocalEngine,
} from "@/lib/local-engine";

const PROXY = "http://127.0.0.1:3005";
const EXTERNAL = {
  baseUrl: "http://engine.example:8000/v1",
  modelId: "qwen3-32b",
  contextWindow: 65536,
  maxTokens: 16384,
  imageInput: true,
  harness: "openclaw",
  savedAt: "2026-11-12T10:00:00.000Z",
  previous: { store: {} },
};

beforeEach(() => {
  state.value = {};
  state.key = null;
  alias.mockReset().mockResolvedValue("gemma4-e2b-it-q4_0");
  show.mockReset().mockResolvedValue({ status: "ok", payload: {} });
  vi.stubEnv("CLAWBOX_LOCAL_AI_PROXY_BASE_URL", PROXY);
  vi.stubEnv("LLAMACPP_CONTEXT_WINDOW", "");
  vi.stubEnv("LLAMACPP_MAX_TOKENS", "");
});

describe("which engine holds the Local AI slot", () => {
  it("is none when Local AI is off and no External engine is selected", async () => {
    expect(await resolveLocalEngine()).toBeNull();
    state.value = { local_ai_configured: false, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/gemma4-e2b-it-q4_0" };
    expect(await resolveLocalEngine()).toBeNull();
  });

  it("is llama.cpp through the Local AI proxy, with the install's bearer and its window", async () => {
    state.value = { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/gemma4-e2b-it-q4_0" };
    expect(await resolveLocalEngine()).toEqual({
      kind: "llamacpp",
      model: "gemma4-e2b-it-q4_0",
      modelRef: "llamacpp/gemma4-e2b-it-q4_0",
      chatUrl: `${PROXY}/setup-api/local-ai/llamacpp/v1/chat/completions`,
      authorization: "Bearer local-install-token",
      contextTokens: 32768,
      maxOutputTokens: 8192,
      parallel: 1,
      imageInput: false,
    });
  });

  it("names the model the device is configured to run, else the store's", async () => {
    state.value = { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/qwen3.6-35b-a3b-mtp" };
    alias.mockResolvedValue("qwen3.6-35b-a3b-mtp");
    expect((await resolveLocalEngine())?.model).toBe("qwen3.6-35b-a3b-mtp");
    alias.mockResolvedValue(null);
    expect((await resolveLocalEngine())?.modelRef).toBe("llamacpp/qwen3.6-35b-a3b-mtp");
  });

  it("is Ollama through the proxy's OpenAI surface, sized by ClawBox's Ollama window unless the model sets its own", async () => {
    state.value = { local_ai_configured: true, local_ai_provider: "ollama", local_ai_model: "ollama/gemma3:4b" };
    const engine = await resolveLocalEngine();
    expect(engine).toMatchObject({
      kind: "ollama",
      model: "gemma3:4b",
      modelRef: "ollama/gemma3:4b",
      chatUrl: `${PROXY}/setup-api/local-ai/ollama/v1/chat/completions`,
      authorization: "Bearer local-install-token",
      contextTokens: OLLAMA_DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: 2048,
      imageInput: null,
    });
    // The training maximum is not the served window: only a num_ctx is.
    show.mockResolvedValue({ status: "ok", payload: { parameters: "num_ctx    16384\nstop \"<eos>\"", model_info: { "gemma3.context_length": 131072 } } });
    expect(await resolveLocalEngine()).toMatchObject({ contextTokens: 16384, maxOutputTokens: 4096 });
    show.mockResolvedValue({ status: "ok", payload: { model_info: { "gemma3.context_length": 131072 } } });
    expect((await resolveLocalEngine())?.contextTokens).toBe(OLLAMA_DEFAULT_CONTEXT_TOKENS);
    show.mockResolvedValue({ status: "unreachable" });
    expect((await resolveLocalEngine())?.contextTokens).toBe(OLLAMA_DEFAULT_CONTEXT_TOKENS);
  });

  it("is none for an Ollama model Ollama says it does not have", async () => {
    state.value = { local_ai_configured: true, local_ai_provider: "ollama", local_ai_model: "ollama/gone:1b" };
    show.mockResolvedValue({ status: "not-installed" });
    expect(await resolveLocalEngine()).toBeNull();
  });

  it("is the External engine when one is selected, asked directly with the owner's key", async () => {
    state.value = { external_engine: EXTERNAL, local_ai_configured: true, local_ai_provider: "clawext", local_ai_model: "clawext/qwen3-32b" };
    state.key = "sk-owner";
    expect(await resolveLocalEngine()).toEqual({
      kind: "clawext",
      model: "qwen3-32b",
      modelRef: "clawext/qwen3-32b",
      chatUrl: "http://engine.example:8000/v1/chat/completions",
      authorization: "Bearer sk-owner",
      contextTokens: 65536,
      maxOutputTokens: 16384,
      parallel: 1,
      imageInput: true,
    });
    state.key = null;
    expect((await resolveLocalEngine())?.authorization).toBe("Bearer none");
  });

  it("is none for a provider it does not know, or an Ollama row with no model", async () => {
    state.value = { local_ai_configured: true, local_ai_provider: "deepseek", local_ai_model: "deepseek/x" };
    expect(await resolveLocalEngine()).toBeNull();
    state.value = { local_ai_configured: true, local_ai_provider: "ollama", local_ai_model: "" };
    expect(await resolveLocalEngine()).toBeNull();
  });
});

describe("one request", () => {
  it("asks the on-box runtimes for no thinking, through the proxy's own word", async () => {
    state.value = { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/gemma4-e2b-it-q4_0" };
    const engine = (await resolveLocalEngine())!;
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await postLocalChat(engine, { max_tokens: 100, temperature: 0, messages: [{ role: "user", content: "hi" }] }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(engine.chatUrl);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer local-install-token");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gemma4-e2b-it-q4_0",
      stream: false,
      max_tokens: 100,
      temperature: 0,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    });
  });

  it("sends the External engine no field it may not know", async () => {
    state.value = { external_engine: EXTERNAL };
    const engine = (await resolveLocalEngine())!;
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await postLocalChat(engine, { max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.model).toBe("qwen3-32b");
  });
});

describe("which engine can look at a picture", () => {
  it("the External engine by the owner's answer, llama.cpp never, Ollama by the model's capability", async () => {
    state.value = { external_engine: EXTERNAL };
    expect(await localEngineSeesPictures((await resolveLocalEngine())!)).toBe(true);
    state.value = { external_engine: { ...EXTERNAL, imageInput: false } };
    expect(await localEngineSeesPictures((await resolveLocalEngine())!)).toBe(false);

    state.value = { local_ai_configured: true, local_ai_provider: "llamacpp", local_ai_model: "llamacpp/gemma4-e2b-it-q4_0" };
    expect(await localEngineSeesPictures((await resolveLocalEngine())!)).toBe(false);

    state.value = { local_ai_configured: true, local_ai_provider: "ollama", local_ai_model: "ollama/gemma3:4b" };
    const ollama = (await resolveLocalEngine())!;
    show.mockResolvedValue({ status: "ok", payload: { capabilities: ["completion", "vision"] } });
    expect(await localEngineSeesPictures(ollama)).toBe(true);
    show.mockResolvedValue({ status: "ok", payload: { capabilities: ["completion", "thinking"] } });
    expect(await localEngineSeesPictures(ollama)).toBe(false);
    show.mockResolvedValue({ status: "unreachable" });
    expect(await localEngineSeesPictures(ollama)).toBe(false);
  });
});

describe("the refs a local answer is recorded under", () => {
  it("are the three engines' own, never a ClawBox AI model id", () => {
    for (const ref of ["llamacpp/gemma4-e2b-it-q4_0", "ollama/gemma3:4b", "clawext/qwen3-32b"]) expect(isLocalEngineRef(ref), ref).toBe(true);
    for (const ref of ["deepseek-v4-flash", "stub-flash", "llamacpp/", "ollama", "clawai/x", null, 3]) expect(isLocalEngineRef(ref), String(ref)).toBe(false);
  });
});
