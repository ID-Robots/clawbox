import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn(),
}));

import { readConfig } from "@/lib/openclaw-config";
const mockReadConfig = vi.mocked(readConfig);

describe("/setup-api/ai-models/status", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/ai-models/status/route");
    GET = mod.GET;
  });

  it("returns connected status with provider info", async () => {
    mockReadConfig.mockResolvedValue({
      auth: {
        profiles: {
          "anthropic:default": { provider: "anthropic", mode: "token" },
        },
      },
      agents: {
        defaults: { model: { primary: "claude-3-opus" } },
      },
    } as never);
    const res = await GET();
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.provider).toBe("anthropic");
    expect(body.providerLabel).toBe("Anthropic Claude");
    expect(body.mode).toBe("token");
    expect(body.model).toBe("claude-3-opus");
  });

  it("returns disconnected when no profiles", async () => {
    mockReadConfig.mockResolvedValue({ auth: { profiles: {} }, agents: {} } as never);
    const res = await GET();
    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(body.provider).toBeNull();
  });

  it("returns disconnected on error", async () => {
    mockReadConfig.mockRejectedValue(new Error("fail"));
    const res = await GET();
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it("infers provider from profile key when not explicit", async () => {
    mockReadConfig.mockResolvedValue({
      auth: {
        profiles: {
          "openai:default": {},
        },
      },
      agents: { defaults: {} },
    } as never);
    const res = await GET();
    const body = await res.json();
    expect(body.provider).toBe("openai");
    expect(body.providerLabel).toBe("OpenAI GPT");
  });

  it("matches the active profile to the primary model when fallback profiles exist", async () => {
    // Simulates a device that previously had Anthropic OAuth configured and
    // then switched to ClawBox AI — both profiles remain in the file but the
    // primary model points at deepseek.
    mockReadConfig.mockResolvedValue({
      auth: {
        profiles: {
          "anthropic:default": { provider: "anthropic", mode: "oauth" },
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
        },
      },
      agents: {
        defaults: { model: { primary: "deepseek/deepseek-chat" } },
      },
    } as never);
    const res = await GET();
    const body = await res.json();
    expect(body.provider).toBe("clawai");
    expect(body.providerLabel).toBe("ClawBox AI");
    expect(body.mode).toBe("api_key");
    expect(body.model).toBe("deepseek/deepseek-chat");
  });

  it("reports the llama.cpp provider label", async () => {
    mockReadConfig.mockResolvedValue({
      auth: {
        profiles: {
          "llamacpp:default": { provider: "llamacpp", mode: "api_key" },
        },
      },
      agents: {
        defaults: { model: { primary: "llamacpp/gemma-q4" } },
      },
    } as never);

    const res = await GET();
    const body = await res.json();

    expect(body.provider).toBe("llamacpp");
    expect(body.providerLabel).toBe("llama.cpp Local");
    expect(body.model).toBe("llamacpp/gemma-q4");
  });

  it("normalizes provider aliases like openai-codex for the UI", async () => {
    mockReadConfig.mockResolvedValue({
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
      agents: {
        defaults: { model: { primary: "openai-codex/gpt-5.4" } },
      },
    } as never);

    const res = await GET();
    const body = await res.json();

    expect(body.provider).toBe("openai");
    expect(body.providerLabel).toBe("OpenAI GPT");
    expect(body.model).toBe("openai-codex/gpt-5.4");
  });
});
