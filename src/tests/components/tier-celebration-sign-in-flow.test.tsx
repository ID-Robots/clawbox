/**
 * The ClawBox AI sign-in, end to end across the box's own boundary: the REAL
 * status route answers the REAL login poll that drives the REAL celebration.
 * Only what lies outside the box is stubbed — the portal's `device-info`
 * answer — together with the box's stores, filled exactly as a sign-in leaves
 * them.
 *
 * The regression: a FREE account signed in and was greeted with "Welcome to
 * ClawBox Pro 🎉". A Free sign-in stamps the box's MODEL tier `clawai_tier:
 * "flash"` (Free and Pro run the same model), and whenever the portal did not
 * answer the route reported that stamp as the account's tier, which the
 * celebration ranks as the Pro plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";

const t = (key: string) => translations.en[key] ?? key;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const h = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  store: new Map<string, unknown>(),
}));
vi.mock("@/lib/client-kv", () => ({
  get: (key: string) => h.kv.get(key) ?? null,
  set: (key: string, value: string) => { h.kv.set(key, value); },
  remove: (key: string) => { h.kv.delete(key); },
}));
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => h.store.get(key),
  getKnown: async (key: string) => h.store.get(key),
  set: async (key: string, value: unknown) => {
    if (value === undefined) h.store.delete(key);
    else h.store.set(key, value);
  },
}));
// openclaw.json after the sign-in: the ClawBox AI profile and its portal token.
vi.mock("@/lib/openclaw-config", () => ({
  readConfig: async () => ({
    auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    models: { providers: { deepseek: { apiKey: "claw_signin_flow_token" } } },
  }),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "openclaw" }));
vi.mock("@/lib/hermes-config-cache", () => ({ hermesConfigGetMany: async () => ({}) }));

import TierUpgradeCelebration from "@/components/TierUpgradeCelebration";
import { GET as statusGET } from "@/app/setup-api/ai-models/status/route";
import { _resetPortalTierCache } from "@/lib/clawbox-ai-portal-tier";

const SEEN_KEY = "clawai_tier_seen";

/** The portal's device-info answer for the account that signed in, or a dead uplink. */
type Portal = { tier: string; deviceTier?: string } | "unreachable";

function boxSignedIn(portal: Portal, stores: Record<string, unknown>) {
  for (const [key, value] of Object.entries(stores)) h.store.set(key, value);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url === "/setup-api/ai-models/status") return statusGET();
    if (url.includes("/api/clawbox-ai/device-info")) {
      if (portal === "unreachable") throw new Error("ETIMEDOUT");
      return new Response(JSON.stringify(portal), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

async function openDesktop() {
  render(<TierUpgradeCelebration />);
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.kv.clear();
  h.store.clear();
  _resetPortalTierCache();
  // The desktop saw the box before the sign-in, with no paid plan.
  h.kv.set(SEEN_KEY, "free");
});

afterEach(() => vi.unstubAllGlobals());

describe("signing a box in to ClawBox AI", () => {
  it("greets a FREE account with nothing when the portal answers", async () => {
    // What the configure route leaves after a Free sign-in the portal answered.
    boxSignedIn({ tier: "free", deviceTier: "flash" }, { clawai_tier: "flash", clawai_plan_tier: "free" });

    await openDesktop();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(t("tierCelebration.proHeadline"))).toBeNull();
  });

  it("greets a FREE account with nothing when the portal cannot answer", async () => {
    // The reported case: the portal did not answer, so nothing but the model
    // stamp the Free sign-in wrote is on the box.
    boxSignedIn("unreachable", { clawai_tier: "flash" });

    await openDesktop();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(t("tierCelebration.proHeadline"))).toBeNull();
  });

  it("greets a FREE account with nothing when the portal is down but its plan is on record", async () => {
    boxSignedIn("unreachable", { clawai_tier: "flash", clawai_plan_tier: "free" });

    await openDesktop();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("welcomes a PRO account to ClawBox Pro", async () => {
    boxSignedIn({ tier: "pro" }, { clawai_tier: "flash", clawai_plan_tier: "flash" });

    await openDesktop();

    expect(await screen.findByText(t("tierCelebration.proHeadline"))).toBeInTheDocument();
  });

  it("welcomes a MAX account to ClawBox Max", async () => {
    boxSignedIn({ tier: "max", deviceTier: "pro" }, { clawai_tier: "pro", clawai_plan_tier: "pro" });

    await openDesktop();

    expect(await screen.findByText(t("tierCelebration.maxHeadline"))).toBeInTheDocument();
    expect(screen.queryByText(t("tierCelebration.proHeadline"))).toBeNull();
  });
});
