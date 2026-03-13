import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/oauth-config", () => ({
  OAUTH_PROVIDERS: {
    openai: { name: "OpenAI" },
    anthropic: { name: "Anthropic" },
  },
  DEVICE_AUTH_PROVIDERS: {
    openai: { name: "OpenAI Device" },
    google: { name: "Google" },
  },
}));

describe("GET /setup-api/ai-models/oauth/providers", () => {
  let providersGet: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/app/setup-api/ai-models/oauth/providers/route");
    providersGet = mod.GET;
  });

  it("returns list of all providers", async () => {
    const res = await providersGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it("includes providers from both oauth and device auth", async () => {
    const res = await providersGet();
    const body = await res.json();

    expect(body.providers).toContain("openai");
    expect(body.providers).toContain("anthropic");
    expect(body.providers).toContain("google");
  });

  it("deduplicates providers", async () => {
    const res = await providersGet();
    const body = await res.json();

    // openai is in both OAUTH_PROVIDERS and DEVICE_AUTH_PROVIDERS
    const openaiCount = body.providers.filter((p: string) => p === "openai").length;
    expect(openaiCount).toBe(1);
  });
});
