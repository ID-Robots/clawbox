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
});
