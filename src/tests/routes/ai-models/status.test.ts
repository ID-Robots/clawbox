import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

describe("/setup-api/ai-models/status", () => {
  let GET: () => Promise<Response>;
  let resetPortalTierCache: () => void;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetConfigValue.mockResolvedValue(null);
    mockSetConfigValue.mockResolvedValue(undefined);
    // Default to the OpenClaw harness so the existing suite exercises the
    // openclaw.json path unchanged; the Hermes suite overrides this.
    mockGetActiveHarness.mockResolvedValue("openclaw");
    mockHermesConfigGetMany.mockResolvedValue({});
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("@/app/setup-api/ai-models/status/route");
    GET = mod.GET;
    // The portal-tier cache lives in the shared lib, not the route — a
    // route.ts may only export handlers and route config.
    resetPortalTierCache = (await import("@/lib/clawbox-ai-portal-tier"))._resetPortalTierCache;
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

    it("persists the portal-confirmed tier so the unreachable-fallback stops flapping", async () => {
      // Free account whose stored clawai_tier is a stale "flash" (paid badge).
      // The portal confirms Free, so we persist null — a later portal blip
      // then falls back to Free instead of resurfacing the paid badge and
      // re-firing the tier-upgrade celebration.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "free", deviceTier: null }),
        { status: 200 },
      ));

      await GET();

      expect(mockSetConfigValue).toHaveBeenCalledWith("clawai_tier", null);
    });

    it("does not rewrite clawai_tier when the portal confirms the stored tier", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      await GET();

      expect(mockSetConfigValue).not.toHaveBeenCalled();
    });

    it("queries the portal even when local picker is unset so Free → Paid upgrades are visible without re-login", async () => {
      // Free users who paired without picking a paid pill ALSO need the
      // portal lookup so a later upgrade is detected without forcing
      // a re-login. mapPortalTier now guarantees a paid response —
      // a stale deviceTier stamp on a Free plan can no longer promote
      // the user, so we can safely query the portal regardless of the
      // local picker state.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(null);
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "free", deviceTier: null }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBeNull();
      expect(body.clawaiAccountTier).toBeNull();
      expect(body.tierSource).toBe("portal");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("detects a Free → Pro portal upgrade without a stored local picker", async () => {
      // The core bug this PR fixes: a user signed in as Free (no
      // local clawai_tier stored) upgrades on the portal. The next
      // status poll surfaces the new paid tier — no re-login required.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(null);
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "pro", deviceTier: null }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBe("flash");
      expect(body.clawaiAccountTier).toBe("flash");
      expect(body.tierSource).toBe("portal");
    });

    it("ignores a stale deviceTier=flash stamp when the portal still reports Free", async () => {
      // mapPortalTier defends against a portal-side bug where a Free
      // user could receive a paid deviceTier stamp. Without this
      // guard the badge would falsely promote a Free user.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(null);
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "free", deviceTier: "flash" }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBeNull();
      expect(body.clawaiAccountTier).toBeNull();
      expect(body.tierSource).toBe("portal");
    });

    it("preserves localTier on portal 401/403 (auth lost, might still be paid)", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response("invalid_token", { status: 403 }));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBe("pro");
      expect(body.tierSource).toBe("picker");
    });

    it("says the credential was REJECTED, not merely that the portal was quiet", async () => {
      // TASK-419. The tier must not move — a Max owner whose token was
      // revoked still pays for Max, and demoting him here is the bug that
      // reasoning was written to prevent. What the response owes the customer
      // is the OTHER half: the portal ANSWERED, and what it said was no.
      // Beta reported exactly the same payload for "portal said no" and
      // "portal never answered", so Settings painted a healthy paid badge
      // over a credential the box had just been told was dead.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ error: { code: "invalid_token", type: "auth_error" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTokenRejected).toBe(true);
      // Unchanged, on purpose.
      expect(body.clawaiTier).toBe("pro");
      expect(body.tierSource).toBe("picker");
    });

    it("writes the portal's refusal where the root boot script can read it", async () => {
      // TASK-727. The pre-start decides on every gateway start whether to
      // declare the agent's image path, and the pinned core has no back-off to
      // fall back on — so "the portal refused this credential" has to leave
      // this process. `clawai_credential_refused_at` is the same store the tier
      // stamp above uses, and `CLAWBOX_DEVICE_STORE` is the same file.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(undefined);
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ error: { code: "invalid_token", type: "auth_error" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      ));

      await GET();

      expect(mockSetConfigValue).toHaveBeenCalledWith(
        "clawai_credential_refused_at",
        expect.any(Number),
      );
    });

    it("clears it again the moment the portal accepts the credential", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      // A refusal is on record; the tier is the one the portal is about to
      // confirm, so the tier write below cannot be what is asserted.
      mockGetConfigValue.mockImplementation(async (key: string) =>
        key === "clawai_credential_refused_at" ? 1_788_000_000_000 : "pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      await GET();

      expect(mockSetConfigValue).toHaveBeenCalledWith("clawai_credential_refused_at", undefined);
    });

    it("does not write down a refusal the portal module deliberately did not remember", async () => {
      // The re-link race, and the reason this persists off
      // `clawaiTokenRejectedByPortal()` rather than off the lookup's own
      // `rejected`. A poll goes out with the OLD token; while its 403 is in
      // flight the new token is proven good, so `fetchPortalTier` returns the
      // verdict to its caller and deliberately does NOT remember it. Writing it
      // to disk anyway would stand the image path down at the very restart the
      // re-link triggers.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(undefined);
      let releaseOldTokenRefusal: () => void = () => {};
      const oldTokenAnswered = new Promise<void>((resolve) => { releaseOldTokenRefusal = resolve; });
      fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
        if (auth.includes("claw_NEW")) {
          return new Response(JSON.stringify({ tier: "max", deviceTier: "pro" }), { status: 200 });
        }
        await oldTokenAnswered;
        return new Response(
          JSON.stringify({ error: { code: "invalid_token" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      });

      const inFlight = GET();
      // The re-link lands while that 403 is still on the wire.
      const portal = await import("@/lib/clawbox-ai-portal-tier");
      await portal.fetchPortalTier("claw_NEW");
      releaseOldTokenRefusal();
      await inFlight;

      expect(mockSetConfigValue).not.toHaveBeenCalledWith(
        "clawai_credential_refused_at",
        expect.anything(),
      );
    });

    it("does not let a slow portal answer erase a refusal recorded since it was asked", async () => {
      // The re-link race, the other half. The poll asks about the credential the
      // box held when the request started; four seconds later the device has
      // been re-linked and the NEW credential refused. A clear here would be a
      // verdict about a token the box no longer holds erasing one about the
      // token it does — and the next gateway start would re-arm the image path
      // over a credential the proxy refuses.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      const stamps: Record<string, unknown> = { clawai_tier: "pro" };
      mockGetConfigValue.mockImplementation(async (key: string) => stamps[key]);
      mockSetConfigValue.mockImplementation(async (key: string, value: unknown) => {
        if (value === undefined) delete stamps[key];
        else stamps[key] = value;
      });
      fetchSpy.mockImplementation(async () => {
        // A refusal of the credential the box holds NOW lands while this
        // lookup is still on the wire.
        stamps.clawai_credential_refused_at = Date.now() + 1;
        return new Response(JSON.stringify({ tier: "max", deviceTier: "pro" }), { status: 200 });
      });

      await GET();

      expect(stamps.clawai_credential_refused_at).toBeTypeOf("number");
      expect(mockSetConfigValue).not.toHaveBeenCalledWith(
        "clawai_credential_refused_at",
        undefined,
      );
    });

    it("records nothing when the portal merely failed to answer", async () => {
      // The false-failure half of the persisted fact: an unreachable portal
      // would stand the image path down at the next boot on a box whose
      // credential is perfectly good.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue(undefined);
      fetchSpy.mockResolvedValue(new Response("upstream is down", { status: 503 }));

      await GET();

      expect(mockSetConfigValue).not.toHaveBeenCalledWith(
        "clawai_credential_refused_at",
        expect.anything(),
      );
    });

    it("does not call an unreachable portal a rejection", async () => {
      // The false-failure half. A 500, a timeout or a dead uplink says nothing
      // about the credential, and telling a customer on a train to re-link a
      // perfectly good device is the same lie in the other direction.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response("upstream is down", { status: 503 }));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTokenRejected).toBe(false);
      expect(body.clawaiTier).toBe("pro");
      expect(body.tierSource).toBe("picker");
    });

    it("does not accuse a credential the portal never refused", async () => {
      // The healthy direction, and the one that would make this field a
      // liability if it were wrong: a 200 says the token works, and nothing
      // downstream may be told otherwise.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      const body = await (await GET()).json();
      expect(body.clawaiTokenRejected).toBe(false);
      expect(body.tierSource).toBe("portal");
    });

    it("does not call an interception page a rejection", async () => {
      // A corporate proxy, a hotel captive portal or a CDN anti-bot page can
      // answer 403 to this GET. Only the portal's OWN auth error counts —
      // otherwise the box tells an owner with a perfectly valid token to
      // re-link the device, which is this bug pointing the other way.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        "<html><body>Attention Required! | Cloudflare</body></html>",
        { status: 403, headers: { "content-type": "text/html" } },
      ));

      const body = await (await GET()).json();
      expect(body.clawaiTokenRejected).toBe(false);
      expect(body.clawaiTier).toBe("pro");
    });

    it("stops accusing the OLD token once a new one works", async () => {
      // A device holds one ClawBox AI credential. Re-linking mints a new one,
      // and the rejection recorded against the retired one must not keep the
      // Providers strip in "Needs sign-in" for the rest of its cache window —
      // re-linking is the remedy the failure text prints.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ error: { code: "invalid_token" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      ));
      expect((await (await GET()).json()).clawaiTokenRejected).toBe(true);

      mockReadConfig.mockResolvedValue({
        ...clawaiConfigBase,
        models: { providers: { deepseek: { apiKey: "claw_relinked456" } } },
      } as never);
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      const body = await (await GET()).json();
      expect(body.clawaiTokenRejected).toBe(false);
      const { clawaiTokenRejectedByPortal } = await import("@/lib/clawbox-ai-portal-tier");
      expect(clawaiTokenRejectedByPortal()).toBe(false);
    });

    it("ignores a rejection that lands after another token was proven good", async () => {
      // Completion order is not arrival order. A re-link starts a lookup for
      // the new token while the old one's is still in flight; if the old one
      // comes back 403 afterwards, remembering it would make the Providers
      // strip say "Needs sign-in" about a device that was just successfully
      // re-linked.
      const portal = await import("@/lib/clawbox-ai-portal-tier");
      let releaseOld: () => void = () => {};
      const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });

      fetchSpy.mockImplementation(async (url: unknown, init?: unknown) => {
        const auth = (init as { headers?: Record<string, string> } | undefined)?.headers?.Authorization;
        if (auth?.endsWith("claw_old111")) {
          await oldPending;
          return new Response(
            JSON.stringify({ error: { code: "invalid_token" } }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ tier: "max", deviceTier: "pro" }), { status: 200 });
      });

      const stale = portal.fetchPortalTier("claw_old111");
      await portal.fetchPortalTier("claw_new222");
      expect(portal.clawaiTokenRejectedByPortal()).toBe(false);

      releaseOld();
      await expect(stale).resolves.toMatchObject({ source: "unreachable", rejected: true });
      // The caller that asked about the old token is told the truth; nothing
      // else is.
      expect(portal.clawaiTokenRejectedByPortal()).toBe(false);
    });

    it("does not buffer an oversized refusal body looking for a code", async () => {
      // An interception appliance can answer 401/403 with a full HTML page, and
      // the 4 s fetch timeout bounds duration, not bytes.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ error: { code: "invalid_token" }, pad: "x".repeat(8192) }),
        { status: 403, headers: { "content-type": "application/json" } },
      ));

      const body = await (await GET()).json();
      // Past the cap it is not the envelope we are looking for: unreachable,
      // not rejected — the safe direction.
      expect(body.clawaiTokenRejected).toBe(false);
      expect(body.clawaiTier).toBe("pro");
    });

    it("surfaces the portal's entitlement list beside the badge", async () => {
      // The badge is the device-pair stamp; the list is what the account may
      // actually run. A Max account paired while it was on the Pro plan reads
      // "flash" and still carries the Pro id — the picker gates on the list.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({
          tier: "max",
          deviceTier: "flash",
          allowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
        }),
        { status: 200 },
      ));

      const body = await (await GET()).json();

      expect(body.clawaiAccountTier).toBe("flash");
      expect(body.clawaiAllowedModels).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    });

    it("fills the list from the badge when the portal answered without one", async () => {
      // An older portal build publishes no `allowedModels`. There the badge is
      // all the entitlement there has ever been, so nothing that used to be
      // refused may quietly become allowed — but this is the ANSWERED branch
      // only; an unreachable portal still yields null.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "pro", deviceTier: "flash" }),
        { status: 200 },
      ));

      const body = await (await GET()).json();

      expect(body.clawaiAllowedModels).toEqual(["deepseek-v4-flash"]);
    });

    it("keeps the Max id in that fallback when the PLAN is Max and only the device stamp is Flash", async () => {
      // TASK-691, reached through the compatibility door. `mapPortalTier`
      // prefers `deviceTier` on purpose, so deriving the fallback list from the
      // badge alone gave a Max subscriber `["deepseek-v4-flash"]` — which the
      // boot guard reads as a POSITIVE refusal and writes his primary model
      // down on, under a message telling him to buy the plan he already has.
      // The plan is what an entitlement may be read from.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("flash");
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "flash" }),
        { status: 200 },
      ));

      const body = await (await GET()).json();

      // The BADGE still follows the device stamp — that is its job.
      expect(body.clawaiAccountTier).toBe("flash");
      expect(body.clawaiAllowedModels).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    });

    it("says null — not an empty list — when the portal could not be asked", async () => {
      // Null is "not answered". An empty list would read as "nothing is
      // allowed" and lock the box out of its own models.
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockRejectedValue(new Error("ETIMEDOUT"));

      const body = await (await GET()).json();

      expect(body.clawaiTier).toBe("pro");
      expect(body.clawaiAllowedModels).toBeNull();
    });

    it("negative-caches an unreachable verdict so back-to-back polls don't hammer the portal", async () => {
      mockReadConfig.mockResolvedValue(clawaiConfigBase as never);
      mockGetConfigValue.mockResolvedValue("pro");
      fetchSpy.mockResolvedValue(new Response("invalid_token", { status: 401 }));

      const first = await (await GET()).json();
      const second = await (await GET()).json();

      expect(first.clawaiTier).toBe("pro");
      expect(first.tierSource).toBe("picker");
      expect(second.clawaiTier).toBe("pro");
      expect(second.tierSource).toBe("picker");
      // Second call inside the unreachable TTL must hit the negative
      // cache instead of re-fetching from the portal.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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
      // Distinct values from each source so the test forces the route
      // to actually consult the portal — without this discrimination
      // the test would still pass if a regression silently dropped the
      // portal call and read clawaiAccountTier from the stale local
      // picker. Local picker says "flash"; portal says "pro". A
      // clawaiAccountTier of "pro" is only reachable via the portal.
      mockGetConfigValue.mockResolvedValue("flash");
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
      // Portal must be consulted whenever a clawai profile exists, so a
      // plan downgrade upstream is reflected on next /status read.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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
      // → the portal is still consulted so a later Free → Paid upgrade
      // is visible without forcing a re-login. The Free portal verdict
      // keeps clawaiAccountTier null. clawaiConfigured is true so the
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
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "free", deviceTier: null }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiTier).toBeNull();
      expect(body.clawaiAccountTier).toBeNull();
      expect(body.clawaiConfigured).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  describe("hermes edition", () => {
    beforeEach(() => {
      // Active harness is Hermes: there is no openclaw.json, so the route must
      // resolve ClawBox AI from the Hermes config instead.
      mockGetActiveHarness.mockResolvedValue("hermes");
    });

    it("reports clawaiConfigured=true for a signed-in Hermes box (the Remote Control banner fix)", async () => {
      mockHermesConfigGetMany.mockResolvedValue({
        "model.provider": "clawai",
        "model.default": "deepseek-v4-flash",
        "providers.clawai.base_url": "https://clawbox.com/api/ai",
      });
      mockGetConfigValue.mockImplementation(async (key: string) =>
        key === "clawai_token" ? "claw_hermes123" : key === "clawai_tier" ? "flash" : null,
      );
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "free", deviceTier: null }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.provider).toBe("clawai");
      expect(body.providerLabel).toBe("ClawBox AI");
      expect(body.connected).toBe(true);
      expect(body.clawaiConfigured).toBe(true);
      // The OpenClaw config must NOT be read on a Hermes box.
      expect(mockReadConfig).not.toHaveBeenCalled();
      // The portal was consulted with the token stored in the Hermes config-store.
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/clawbox-ai/device-info"),
        expect.objectContaining({ headers: { Authorization: "Bearer claw_hermes123" } }),
      );
    });

    it("reports clawaiConfigured=false when the Hermes config has no ClawBox AI provider block", async () => {
      mockHermesConfigGetMany.mockResolvedValue({
        "model.provider": "openrouter",
        "model.default": "openrouter/anthropic/claude-haiku-4.5",
        "providers.clawai.base_url": "",
      });

      const res = await GET();
      const body = await res.json();

      expect(body.provider).toBe("openrouter");
      expect(body.clawaiConfigured).toBe(false);
      expect(body.clawaiTier).toBeNull();
      expect(mockReadConfig).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("keeps the account tier available when ClawBox AI is configured but not the active provider", async () => {
      // ClawBox AI provider block present, but the user switched the active
      // provider to the on-device model — loggedIn must stay true.
      mockHermesConfigGetMany.mockResolvedValue({
        "model.provider": "clawlocal",
        "model.default": "gemma4-e2b-it-q4_0",
        "providers.clawai.base_url": "https://clawbox.com/api/ai",
      });
      mockGetConfigValue.mockImplementation(async (key: string) =>
        key === "clawai_token" ? "claw_hermes456" : key === "clawai_tier" ? "pro" : null,
      );
      fetchSpy.mockResolvedValue(new Response(
        JSON.stringify({ tier: "max", deviceTier: "pro" }),
        { status: 200 },
      ));

      const res = await GET();
      const body = await res.json();

      expect(body.clawaiConfigured).toBe(true);
      // Active provider isn't clawai, so the header badge tier is blank...
      expect(body.clawaiTier).toBeNull();
      // ...but the account tier is still resolved for ClawKeep / Remote Control.
      expect(body.clawaiAccountTier).toBe("pro");
    });
  });

  it("normalizes the codex provider (and legacy openai-codex) for the UI", async () => {
    mockReadConfig.mockResolvedValue({
      auth: {
        profiles: {
          "codex:default": { provider: "codex", mode: "oauth" },
        },
      },
      agents: {
        defaults: { model: { primary: "codex/gpt-5.4" } },
      },
    } as never);

    const res = await GET();
    const body = await res.json();

    expect(body.provider).toBe("openai");
    expect(body.providerLabel).toBe("OpenAI GPT");
    expect(body.model).toBe("codex/gpt-5.4");
  });
});
