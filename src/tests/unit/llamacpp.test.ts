import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("llamacpp config helpers", () => {
  beforeEach(() => {
    vi.stubEnv("CLAWBOX_LOCAL_AI_PROXY_BASE_URL", "");
    vi.stubEnv("CLAWBOX_PORT", "");
    vi.stubEnv("PORT", "");
  });

  afterEach(() => {
    delete process.env.LLAMACPP_BASE_URL;
    delete process.env.LLAMACPP_MODEL;
    delete process.env.LLAMACPP_CONTEXT_WINDOW;
    delete process.env.LLAMACPP_MAX_TOKENS;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to the Gemma 4 E2B Q4 model id", async () => {
    const mod = await import("@/lib/llamacpp");

    expect(mod.getDefaultLlamaCppModel()).toBe("gemma4-e2b-it-q4_0");
    expect(mod.LLAMACPP_RECOMMENDED_MODELS[0]?.id).toBe("gemma4-e2b-it-q4_0");
    // The model id is llama-server's --alias and stays put; the GGUF behind it
    // moved to Google's QAT release after the on-device bake-off. See
    // src/tests/unit/llamacpp-gguf-pin.test.ts for the installer cross-check.
    expect(mod.getDefaultLlamaCppRepo()).toBe("google/gemma-4-E2B-it-qat-q4_0-gguf");
    expect(mod.getDefaultLlamaCppFile()).toBe("gemma-4-E2B_q4_0-it.gguf");
  });

  it("normalizes a llama.cpp base URL to include /v1", async () => {
    process.env.LLAMACPP_BASE_URL = "http://127.0.0.1:8080";
    const mod = await import("@/lib/llamacpp");

    expect(mod.getLlamaCppBaseUrl()).toBe("http://127.0.0.1:8080/v1");
  });

  it("exposes the ClawBox proxy URL for on-demand llama.cpp startup", async () => {
    const mod = await import("@/lib/llamacpp");

    expect(mod.getLlamaCppProxyBaseUrl()).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
  });

  it("routes the proxy through the configured x64 UI port", async () => {
    vi.stubEnv("CLAWBOX_PORT", "3005");
    const mod = await import("@/lib/llamacpp");

    expect(mod.getLlamaCppProxyBaseUrl())
      .toBe("http://127.0.0.1:3005/setup-api/local-ai/llamacpp/v1");
  });

  it("preserves an explicit local-AI proxy authority", async () => {
    vi.stubEnv("CLAWBOX_PORT", "3005");
    vi.stubEnv("CLAWBOX_LOCAL_AI_PROXY_BASE_URL", "http://10.42.0.1:8080/");
    const mod = await import("@/lib/llamacpp");

    expect(mod.getLlamaCppProxyBaseUrl())
      .toBe("http://10.42.0.1:8080/setup-api/local-ai/llamacpp/v1");
  });

  it("respects an explicit LLAMACPP_MODEL override", async () => {
    process.env.LLAMACPP_MODEL = "custom-gemma-q4";
    const mod = await import("@/lib/llamacpp");

    expect(mod.getDefaultLlamaCppModel()).toBe("custom-gemma-q4");
  });

  it("defaults to a 32k window, started and announced alike, with 8k answers", async () => {
    const mod = await import("@/lib/llamacpp");

    expect(mod.getLlamaCppContextWindow()).toBe(32768);
    // The server is started with the window OpenClaw is told — not 0, which
    // meant the model's trained 128k while OpenClaw believed the default.
    expect(mod.getLlamaCppServerContextSize()).toBe(32768);
    expect(mod.getLlamaCppMaxTokens()).toBe(8192);
  });

  it("respects explicit llama.cpp context and output overrides", async () => {
    process.env.LLAMACPP_CONTEXT_WINDOW = "65536";
    process.env.LLAMACPP_MAX_TOKENS = "12000";
    const mod = await import("@/lib/llamacpp");

    expect(mod.getLlamaCppContextWindow()).toBe(65536);
    expect(mod.getLlamaCppServerContextSize()).toBe(65536);
    expect(mod.getLlamaCppMaxTokens()).toBe(12000);
  });

  it("starts the server at Hermes' floor while Hermes is the runtime, and tells OpenClaw nothing new", async () => {
    const mod = await import("@/lib/llamacpp");
    const { HERMES_MINIMUM_CONTEXT_TOKENS } = await import("@/lib/ollama-model-context");

    // Hermes refuses a session under 64,000 tokens, read off the running server.
    expect(mod.HERMES_LLAMACPP_CONTEXT_WINDOW).toBeGreaterThanOrEqual(HERMES_MINIMUM_CONTEXT_TOKENS);
    expect(mod.getLlamaCppServerContextSize("hermes")).toBe(65536);
    expect(mod.getLlamaCppServerContextSize("openclaw")).toBe(32768);
    // OpenClaw's row keeps the configured window whatever the runtime is.
    expect(mod.getLlamaCppContextWindow()).toBe(32768);
  });

  it("keeps an owner's larger window on Hermes and raises a smaller one to the floor", async () => {
    process.env.LLAMACPP_CONTEXT_WINDOW = "131072";
    let mod = await import("@/lib/llamacpp");
    expect(mod.getLlamaCppServerContextSize("hermes")).toBe(131072);

    vi.resetModules();
    process.env.LLAMACPP_CONTEXT_WINDOW = "16384";
    mod = await import("@/lib/llamacpp");
    expect(mod.getLlamaCppServerContextSize("hermes")).toBe(65536);
    expect(mod.getLlamaCppServerContextSize("openclaw")).toBe(16384);
  });

  it("never lets the answer budget outgrow the window, and falls back on junk", async () => {
    process.env.LLAMACPP_CONTEXT_WINDOW = "16384";
    process.env.LLAMACPP_MAX_TOKENS = "131072";
    let mod = await import("@/lib/llamacpp");
    expect(mod.getLlamaCppMaxTokens()).toBe(16384);

    vi.resetModules();
    process.env.LLAMACPP_CONTEXT_WINDOW = "128";
    process.env.LLAMACPP_MAX_TOKENS = "nope";
    mod = await import("@/lib/llamacpp");
    expect(mod.getLlamaCppContextWindow()).toBe(32768);
    expect(mod.getLlamaCppServerContextSize()).toBe(32768);
    expect(mod.getLlamaCppMaxTokens()).toBe(8192);
  });

  it("infers the auto-start alias from the configured primary model", async () => {
    const mod = await import("@/lib/llamacpp-server");

    expect(mod.getConfiguredLlamaCppModelAlias({
      agents: {
        defaults: {
          model: { primary: "llamacpp/gemma4-e2b-it-q4_0" },
        },
      },
    })).toBe("gemma4-e2b-it-q4_0");
  });

  it("skips auto-start when the configured primary model is not llama.cpp", async () => {
    const mod = await import("@/lib/llamacpp-server");

    expect(mod.getConfiguredLlamaCppModelAlias({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
      },
    })).toBeNull();
  });

  it("infers the auto-start alias from a configured local llama.cpp fallback", async () => {
    const mod = await import("@/lib/llamacpp-server");

    expect(mod.getConfiguredLlamaCppModelAlias({
      agents: {
        defaults: {
          model: {
            primary: "deepseek/deepseek-chat",
            fallbacks: ["deepseek/deepseek-chat"],
          },
        },
      },
      models: {
        providers: {
          llamacpp: {
            models: [{ id: "gemma4-e2b-it-q4_0" }],
          },
        },
      },
    })).toBe("gemma4-e2b-it-q4_0");
  });
});
