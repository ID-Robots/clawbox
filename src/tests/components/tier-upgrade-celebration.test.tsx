/**
 * The plan celebration after a ClawBox AI sign-in.
 *
 * The regression: signing a box in with a FREE account showed "Welcome to
 * ClawBox Pro 🎉". A Free sign-in stamps the box's MODEL tier "flash" — Free
 * and Pro run the same DeepSeek V4 Flash, see `uiTierToDeviceTier` — and the
 * celebration read that model tier as the PLAN, in which "flash" is Pro. The
 * plan is `/setup-api/ai-models/status`'s `clawaiPlan` (the portal's verdict),
 * and every case below answers with the model tier the box really carries, so
 * a celebration that went back to reading it would fail here.
 *
 * The internal plan names are off by one: `flash` is the plan marketed as Pro
 * and `pro` the one marketed as Max.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import TierUpgradeCelebration from "@/components/TierUpgradeCelebration";

const t = (key: string) => translations.en[key] ?? key;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/client-kv", () => ({
  get: (key: string) => kvStore.get(key) ?? null,
  set: (key: string, value: string) => { kvStore.set(key, value); },
  remove: (key: string) => { kvStore.delete(key); },
}));

const SEEN_KEY = "clawai_tier_seen";

/** The status route's answer after the sign-in, as the box really reports it. */
function signedIn(fields: { clawaiAccountTier: "flash" | "pro" | null; clawaiPlan: string | null }) {
  return { connected: true, provider: "clawai", clawaiConfigured: true, clawaiTier: fields.clawaiAccountTier, ...fields };
}

let fetchMock: ReturnType<typeof vi.fn>;

function answerStatus(body: unknown) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
}

/** Render, and let the first status answer land and the effect run on it. */
async function renderAfterFirstAnswer() {
  render(<TierUpgradeCelebration />);
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
  expect(fetchMock).toHaveBeenCalledWith("/setup-api/ai-models/status", expect.anything());
}

beforeEach(() => {
  kvStore.clear();
  // The box was seen before the sign-in, with no paid plan: what the desktop
  // records on its first poll of a box that has no ClawBox AI account yet.
  kvStore.set(SEEN_KEY, "free");
});

afterEach(() => vi.unstubAllGlobals());

describe("TierUpgradeCelebration after a ClawBox AI sign-in", () => {
  it("shows no Pro welcome to a FREE account whose box is stamped flash", async () => {
    // The portal confirmed Free; the box's model tier is "flash", as every
    // Free sign-in leaves it.
    answerStatus(signedIn({ clawaiAccountTier: "flash", clawaiPlan: "free" }));

    await renderAfterFirstAnswer();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(t("tierCelebration.proHeadline"))).toBeNull();
    expect(kvStore.get(SEEN_KEY)).toBe("free");
  });

  it("shows no Pro welcome while a Free sign-in's plan is not known yet", async () => {
    // The portal could not be asked (offline, timeout, a refused lookup) and
    // no plan is on record. The model tier still says "flash"; the plan is
    // null, which is neither an upgrade nor a downgrade.
    answerStatus(signedIn({ clawaiAccountTier: "flash", clawaiPlan: null }));

    await renderAfterFirstAnswer();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(kvStore.get(SEEN_KEY)).toBe("free");
  });

  it("welcomes a PRO account to ClawBox Pro", async () => {
    answerStatus(signedIn({ clawaiAccountTier: "flash", clawaiPlan: "flash" }));

    await renderAfterFirstAnswer();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("tierCelebration.proBadge"))).toBeInTheDocument();
    expect(screen.getByText(t("tierCelebration.proHeadline"))).toBeInTheDocument();
    expect(screen.queryByText(t("tierCelebration.maxHeadline"))).toBeNull();
  });

  it("welcomes a MAX account to ClawBox Max, even on a box that runs Flash", async () => {
    // A Max subscriber may run Flash on this box (`deviceTier: "flash"`); the
    // model tier said Pro, the plan says Max.
    answerStatus(signedIn({ clawaiAccountTier: "flash", clawaiPlan: "pro" }));

    await renderAfterFirstAnswer();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("tierCelebration.maxBadge"))).toBeInTheDocument();
    expect(screen.getByText(t("tierCelebration.maxHeadline"))).toBeInTheDocument();
    expect(screen.queryByText(t("tierCelebration.proHeadline"))).toBeNull();
  });

  it("does not tell a subscriber their plan ended when the plan is merely not known", async () => {
    kvStore.set(SEEN_KEY, "pro");
    answerStatus(signedIn({ clawaiAccountTier: "pro", clawaiPlan: null }));

    await renderAfterFirstAnswer();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(kvStore.get(SEEN_KEY)).toBe("pro");
  });

  it("still tells a subscriber whose plan the portal reports as Free", async () => {
    kvStore.set(SEEN_KEY, "flash");
    answerStatus(signedIn({ clawaiAccountTier: "flash", clawaiPlan: "free" }));

    await renderAfterFirstAnswer();

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("tierCelebration.freeHeadline"))).toBeInTheDocument();
  });
});
