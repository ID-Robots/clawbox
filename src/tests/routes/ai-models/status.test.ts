import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
}));

import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue } from "@/lib/config-store";

const mockReadConfig = vi.mocked(readConfig);
const mockGetConfigValue = vi.mocked(getConfigValue);

describe("/setup-api/ai-models/status", () => {
  let GET: () => Promise<Response>;
  let resetPortalTierCache: () => void;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfigValue.mockResolvedValue(null);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("@/app/setup-api/ai-models/status/route");
    GET = mod.GET;
    resetPortalTierCache = mod._resetPortalTierCache;
    resetPortalTierCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  describe("clawai tier resolution from portal", () => {
    const clawaiConfigBase = {
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      models: { providers: { deepseek: { apiKey: "claw_test123" } } },
    };

    it("uses the portal's tier (Max plan) over the locally-stored picker", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      // Local picker says Pro (flash) — portal will say Max (pro). Portal wins.
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro", allowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"] }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBe("pro");
      expect(body.tierSource).toBe("portal");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/clawbox-ai/device-info"),
        expect.objectContaining({ headers: { Authorization: "Bearer claw_test123" } }),
      );
    });

    it("returns clawaiTier=null when the portal says Free, regardless of the local picker", async () => {
      // The screenshot scenario: Free user pasted a token + clicked Max in
      // the wizard. Local says "pro", portal says "free" — badge should go
      // away (or render Free), not lie about Max.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "free", deviceTier: null, allowedModels: ["deepseek-v4-flash"] }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBeNull();
      expect(body.tierSource).toBe("portal");
    });

    it("returns clawaiTier=null and skips the portal call when local picker is unset", async () => {
      // Defence-in-depth against a portal-side upgrade bug: a Free user
      // who never picked a paid pill should never see a paid badge.
      // We short-circuit the portal call too — saves the 4 s timeout
      // on cold cache and avoids depending on portal correctness for
      // the Free path.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(null);

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBeNull();
      expect(body.tierSource).toBe("picker");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns clawaiTier=null on portal 403 (invalid token) and caches the verdict", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response("invalid_token", { status: 403 }));

      const first = await (await GET()).json();
      const second = await (await GET()).json();

      expect(first.clawaiTier).toBeNull();
      expect(first.tierSource).toBe("portal");
      // 403 caches; the second request must not hit the network again.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(second.clawaiTier).toBeNull();
    });

    it("falls back to the locally-stored tier when the portal is unreachable", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockRejectedValue(new Error("ETIMEDOUT"));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBe("pro");
      expect(body.tierSource).toBe("picker");
    });

    it("falls back to local on portal 5xx (transient upstream error)", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response("boom", { status: 502 }));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBe("flash");
      expect(body.tierSource).toBe("picker");
    });

    it("uses the cached portal verdict on the second request within the TTL", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      await GET();
      await GET();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("uses local tier when the stored deepseek apiKey isn't a claw_ token", async () => {
      // Legacy/byo-key install: the user pasted a raw deepseek API key
      // instead of going through device-flow. Portal can't resolve it,
      // so we keep showing the picker selection.
      mockReadConfig.mockResolvedValue({
        ...clawaiConfigBase,
        models: { providers: { deepseek: { apiKey: "sk-1234" } } },
      } as never);
      mockGetConfigValue.mockResolvedValue("flash");

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBe("flash");
      expect(body.tierSource).toBe("picker");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("clawai account tier vs active provider", () => {
    it("returns clawaiAccountTier=pro alongside clawaiTier=null when chatting via OpenAI but a Max clawai profile is configured", async () => {
      // The bug we're fixing: a Max subscriber switches the chat
      // dropdown to OpenAI. The chat-header badge should hide (no
      // active clawai chat → clawaiTier=null) but ClawKeep + Remote
      // Desktop should stay unlocked because the clawai account is
      // still a paid Max plan (clawaiAccountTier=pro).
      mockReadConfig.mockResolvedValue({
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "token" },
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: { defaults: { model: { primary: "openai/gpt-5" } } },
        models: { providers: { deepseek: { apiKey: "claw_test123" } } },
      } as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      // Active chat is OpenAI — header badge should be empty.
      expect(body.provider).toBe("openai");
      expect(body.clawaiTier).toBeNull();
      // But the user's clawai account is paid Max — paid features
      // (ClawKeep + Remote Desktop) read from clawaiAccountTier.
      expect(body.clawaiAccountTier).toBe("pro");
      expect(body.clawaiConfigured).toBe(true);
      expect(body.tierSource).toBe("picker");
    });

    it("returns clawaiConfigured=false when no clawai profile exists at all", async () => {
      // Pure OpenAI install — never paired with ClawBox AI. The hook
      // uses this to distinguish "Free clawai user" from "no clawai
      // account at all" (the latter is the Sign-in case for the
      // Remote Control panel).
      mockReadConfig.mockResolvedValue({
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "token" },
          },
        },
        agents: { defaults: { model: { primary: "openai/gpt-5" } } },
      } as never);

      const res = await GET();
      const body = await res.json();

      expect(body.provider).toBe("openai");
      expect(body.clawaiTier).toBeNull();
      expect(body.clawaiAccountTier).toBeNull();
      expect(body.clawaiConfigured).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns clawaiAccountTier=null but clawaiConfigured=true for a Free user chatting via OpenAI", async () => {
      // Free user with a paired clawai token but no paid local picker
      // → defence-in-depth keeps the portal call skipped, so
      // clawaiAccountTier stays null. clawaiConfigured is true so the
      // hook reports loggedIn=true (Free users have a paired account).
      mockReadConfig.mockResolvedValue({
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "token" },
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: { defaults: { model: { primary: "openai/gpt-5" } } },
        models: { providers: { deepseek: { apiKey: "claw_test456" } } },
      } as never);
      mockGetConfigValue.mockResolvedValue(null);

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBeNull();
      expect(body.clawaiAccountTier).toBeNull();
      expect(body.clawaiConfigured).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("emits clawaiTier=clawaiAccountTier when ClawBox AI is the active chat provider", async () => {
      // Sanity: when chat IS clawai, both fields agree. The chat-
      // header badge keeps using clawaiTier — this test guards
      // against accidental drift where the two fields could
      // disagree on the happy path.
      mockReadConfig.mockResolvedValue({
        auth: {
          profiles: {
            "deepseek:default": { provider: "deepseek", mode: "api_key" },
          },
        },
        agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
        models: { providers: { deepseek: { apiKey: "claw_test789" } } },
      } as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.provider).toBe("clawai");
      expect(body.clawaiTier).toBe("pro");
      expect(body.clawaiAccountTier).toBe("pro");
      expect(body.clawaiConfigured).toBe(true);
      expect(body.tierSource).toBe("portal");
    });
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
