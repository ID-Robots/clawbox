import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CLAWBOX_AI_IMAGE_MODEL_ID } from "@/lib/clawbox-ai-models";

// The `clawaiImages` block of /setup-api/ai-models/status (TASK-413): the
// monthly image allowance, so a user learns the cap exists before hitting it.
//
// It is an allowance, never a usage count — the cloud proxy holds the only
// counter and reports it in X-ClawBox-Images-* headers the device never sees.
// `monthlyLimit: null` therefore means "we do not know", and the only honest
// source for the plan is a live portal answer on this poll.
//
// Mocks mirror status.test.ts exactly: the route's four collaborators plus
// global fetch, and nothing inside the route itself.

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(),
}));

vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: vi.fn(),
}));

import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue, set as setConfigValue } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { hermesConfigGetMany } from "@/lib/hermes-config-cache";

const mockReadConfig = vi.mocked(readConfig);
const mockGetConfigValue = vi.mocked(getConfigValue);
const mockSetConfigValue = vi.mocked(setConfigValue);
const mockGetActiveHarness = vi.mocked(getActiveHarness);
const mockHermesConfigGetMany = vi.mocked(hermesConfigGetMany);

/** A box paired with ClawBox AI: clawai profile + `claw_*` token. */
const clawaiConfig = {
  auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
  agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
  models: { providers: { deepseek: { apiKey: "claw_test123" } } },
};

function portalSays(tier: string | null, deviceTier: string | null = null) {
  return new Response(JSON.stringify({ tier, deviceTier, allowedModels: [] }), { status: 200 });
}

describe("/setup-api/ai-models/status — clawaiImages", () => {
  let GET: () => Promise<Response>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfigValue.mockResolvedValue(null);
    mockSetConfigValue.mockResolvedValue(undefined);
    mockGetActiveHarness.mockResolvedValue("openclaw");
    mockHermesConfigGetMany.mockResolvedValue({});
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("@/app/setup-api/ai-models/status/route");
    GET = mod.GET;
    // Cache seam lives in the shared lib — see status.test.ts.
    (await import("@/lib/clawbox-ai-portal-tier"))._resetPortalTierCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function images() {
    const body = await (await GET()).json();
    return body.clawaiImages;
  }

  it.each<[string, number, string]>([
    ["free", 5, "Free"],
    ["pro", 50, "Pro"],
    ["max", 200, "Max"],
  ])("reports the %s plan's allowance of %i", async (plan, monthlyLimit, planLabel) => {
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(portalSays(plan));

    expect(await images()).toEqual({
      supported: true,
      model: CLAWBOX_AI_IMAGE_MODEL_ID,
      plan,
      planLabel,
      monthlyLimit,
    });
  });

  it("reports Free's real 5-image allowance even though its device tier is null", async () => {
    // The reason the route carries `plan` next to `tier`: `tier` collapses Free
    // and "portal said something we don't recognise" into the same null, and
    // Free has an allowance worth showing.
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(portalSays("free"));

    const body = await (await GET()).json();
    expect(body.clawaiTier).toBeNull();
    expect(body.clawaiImages.monthlyLimit).toBe(5);
  });

  it("returns a null monthlyLimit when the portal is unreachable", async () => {
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    mockGetConfigValue.mockResolvedValue("pro"); // stale local picker — must not leak into the allowance
    fetchSpy.mockRejectedValue(new Error("ETIMEDOUT"));

    const img = await images();
    expect(img.supported).toBe(true);
    expect(img.plan).toBeNull();
    expect(img.planLabel).toBeNull();
    expect(img.monthlyLimit).toBeNull();
    expect(img.monthlyLimit).not.toBe(0);
  });

  it("returns a null monthlyLimit on a portal 5xx", async () => {
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(new Response("boom", { status: 502 }));

    expect(await images()).toMatchObject({ plan: null, planLabel: null, monthlyLimit: null });
  });

  it("returns a null monthlyLimit on a portal 401/403", async () => {
    // Ambiguous auth failure: could be genuinely Free, could be a revoked token
    // on a paid account. Either way we did not learn the plan.
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(new Response("invalid_token", { status: 403 }));

    expect(await images()).toMatchObject({ plan: null, planLabel: null, monthlyLimit: null });
  });

  it.each(["enterprise", "", "  ", "flash"])(
    "returns a null monthlyLimit when the portal reports the unrecognised tier %j",
    async (tier) => {
      mockReadConfig.mockResolvedValue(clawaiConfig as never);
      fetchSpy.mockResolvedValue(portalSays(tier));

      expect(await images()).toMatchObject({ plan: null, planLabel: null, monthlyLimit: null });
    },
  );

  it("returns a null monthlyLimit when the portal omits `tier` entirely", async () => {
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ deviceTier: "pro" }), { status: 200 }));

    expect(await images()).toMatchObject({ plan: null, monthlyLimit: null });
  });

  it("normalises the portal's casing and padding", async () => {
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(portalSays("  MAX "));

    expect(await images()).toMatchObject({ plan: "max", planLabel: "Max", monthlyLimit: 200 });
  });

  it("serves the plan from the portal cache on a second poll within the TTL", async () => {
    // The cache stores plan alongside tier; if it did not, the second poll
    // would silently drop back to a null allowance and the UI would flicker.
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(portalSays("max"));

    expect((await images()).monthlyLimit).toBe(200);
    expect((await images()).monthlyLimit).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports supported: false with a null allowance on a box with no ClawBox AI", async () => {
    mockReadConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "token" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-3-opus" } } },
    } as never);

    expect(await images()).toEqual({
      supported: false,
      model: CLAWBOX_AI_IMAGE_MODEL_ID,
      plan: null,
      planLabel: null,
      monthlyLimit: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports supported: false when a clawai profile exists but the token is not a portal token", async () => {
    // The install.sh CI path: a raw DeepSeek key, no subscription behind it, so
    // no allowance to report and nothing to ask the portal about.
    mockReadConfig.mockResolvedValue({
      ...clawaiConfig,
      models: { providers: { deepseek: { apiKey: "sk-deepseek-raw" } } },
    } as never);

    const img = await images();
    expect(img.supported).toBe(true); // the clawai profile is there…
    expect(img.plan).toBeNull(); // …but no portal token means no plan
    expect(img.monthlyLimit).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still carries the clawaiImages shape on the catch-path fallback", async () => {
    // Consumers destructure this unconditionally; the error payload must not be
    // the one response missing the key.
    mockReadConfig.mockRejectedValue(new Error("config unreadable"));

    const body = await (await GET()).json();
    expect(body.connected).toBe(false);
    expect(body.clawaiImages).toEqual({
      supported: false,
      model: CLAWBOX_AI_IMAGE_MODEL_ID,
      plan: null,
      planLabel: null,
      monthlyLimit: null,
    });
  });

  it("advertises the same model id the provisioning path writes", async () => {
    mockReadConfig.mockResolvedValue(clawaiConfig as never);
    fetchSpy.mockResolvedValue(portalSays("pro"));

    expect((await images()).model).toBe(CLAWBOX_AI_IMAGE_MODEL_ID);
    expect((await images()).model).not.toContain("/");
  });

  it("resolves the plan on the Hermes harness too", async () => {
    mockGetActiveHarness.mockResolvedValue("hermes");
    mockHermesConfigGetMany.mockResolvedValue({ "providers.clawai.base_url": "https://clawbox.com/api/ai" });
    mockGetConfigValue.mockImplementation(async (key: string) =>
      key === "clawai_token" ? "claw_hermes123" : null,
    );
    fetchSpy.mockResolvedValue(portalSays("max"));

    expect(await images()).toMatchObject({ supported: true, plan: "max", monthlyLimit: 200 });
  });
});
