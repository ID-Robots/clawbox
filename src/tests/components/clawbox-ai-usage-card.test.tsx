/**
 * The ClawBox AI usage card in Settings → Providers
 * (src/components/ClawboxAiUsageCard.tsx).
 *
 * Its three payload states, each against the real English catalogue so a
 * missing key fails here rather than on screen:
 *  - a portal with rolling allowances, on a paid plan: weekly and burst bars
 *    with "frees up at", the four weekly meters, credits with Top up, and the
 *    yearly offer for a monthly subscriber;
 *  - an older portal: its daily fields exactly as sent, and nothing invented;
 *  - the Free plan: Upgrade instead of credits, and no yearly offer.
 * Plus the two "nothing to draw" answers, which must never be a zeroed bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";

const lang = vi.hoisted(() => ({ locale: "en" }));

vi.mock("@/lib/i18n", async (importOriginal) => {
  const { translations: table } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) => {
    const pack = (table as Record<string, Record<string, string>>)[lang.locale] ?? table.en;
    let str = pack[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
    return str;
  };
  return {
    ...(await importOriginal<typeof import("@/lib/i18n")>()),
    useT: () => ({ locale: lang.locale, localeResolved: true, setLocale: () => {}, t }),
  };
});

import ClawboxAiUsageCard from "@/components/ClawboxAiUsageCard";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-17T09:00:00.000Z");

function window(used: number, limit: number, resetAt: string) {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentUsed: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    isOverLimit: limit > 0 && used >= limit,
    resetAt,
  };
}

/** The route's answer for a portal with rolling allowances, as the website sends it. */
function weeklyAnswer(tier: "free" | "pro" | "max", extra: Record<string, unknown> = {}) {
  const inTwoHours = new Date(NOW + 2 * HOUR).toISOString();
  const inThreeDays = new Date(NOW + 72 * HOUR).toISOString();
  return {
    available: true,
    timeZone: "UTC",
    usage: {
      shape: "weekly",
      plan: tier,
      tierDisplayName: tier === "free" ? "Free" : tier === "pro" ? "Pro" : "Max",
      weekly: { ...window(1_200_000, 5_000_000, inThreeDays), unavailable: false },
      burst: { ...window(300_000, 1_250_000, inTwoHours), unavailable: false },
      meters: {
        images: { ...window(4, 40, inThreeDays), unavailable: false },
        speechSeconds: { ...window(610, 3600, inThreeDays), unavailable: false },
        audioSeconds: { ...window(0, 1800, inThreeDays), unavailable: false },
        embeddingsTokens: { ...window(250_000, 2_000_000, inThreeDays), unavailable: false },
      },
      credits: tier === "free"
        ? { balanceCents: 0, usedThisWeekCents: 0, canBuy: false, currency: "EUR", unavailable: false }
        : { balanceCents: 1250, usedThisWeekCents: 120, canBuy: true, currency: "EUR", unavailable: false },
      billingInterval: null,
      legacy: { percentUsed: 24, resetIn: "3d 0h", isOverLimit: false, tier, tierDisplayName: "Pro", buckets: null },
      ...extra,
    },
    percentUsed: 24,
    resetIn: "3d 0h",
    isOverLimit: false,
    tier,
  };
}

function stubUsage(answer: unknown) {
  const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => answer }));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

beforeEach(() => {
  lang.locale = "en";
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ClawBox AI usage card — weekly payload, paid monthly plan", () => {
  it("draws the weekly pool and the burst ceiling with when each frees up", async () => {
    const fetchSpy = stubUsage(weeklyAnswer("pro"));
    render(<ClawboxAiUsageCard />);

    const card = await screen.findByTestId("clawai-usage-card");
    expect(fetchSpy).toHaveBeenCalledWith("/setup-api/ai-models/usage", { cache: "no-store" });
    await vi.waitFor(() => expect(card).toHaveAttribute("data-shape", "weekly"));
    expect(card).toHaveTextContent("ClawBox AI usage");
    expect(card).toHaveTextContent("Pro plan");

    const weekly = within(card).getByTestId("clawai-usage-weekly");
    expect(weekly).toHaveTextContent("Weekly chat allowance");
    expect(weekly).toHaveTextContent("24% used");
    expect(weekly).toHaveTextContent("1.2M of 5M tokens");
    // Three days away: the weekday goes in front of the box-local clock, so
    // "09:00" cannot read as this morning.
    expect(weekly).toHaveTextContent("Frees up at Sun 09:00");
    expect(within(weekly).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "24");

    const burst = within(card).getByTestId("clawai-usage-burst");
    expect(burst).toHaveTextContent("5-hour burst");
    // Later today: the clock alone.
    expect(burst).toHaveTextContent("Frees up at 11:00");
  });

  it("lists the four weekly meters in the units the owner thinks in", async () => {
    stubUsage(weeklyAnswer("pro"));
    render(<ClawboxAiUsageCard />);
    const meters = await screen.findByTestId("clawai-usage-meters");
    expect(within(meters).getByTestId("clawai-usage-meter-images")).toHaveTextContent("Images4 of 40");
    // 610 s is 11 minutes used (rounded up), 3600 s a 60-minute limit.
    expect(within(meters).getByTestId("clawai-usage-meter-speechSeconds")).toHaveTextContent("Text-to-speech minutes11 of 60 min");
    const stt = within(meters).getByTestId("clawai-usage-meter-audioSeconds");
    expect(stt).toHaveTextContent("Speech-to-text minutes0 of 30 min");
    // Nothing used, nothing to free up.
    expect(stt).not.toHaveTextContent("Frees up");
    expect(within(meters).getByTestId("clawai-usage-meter-embeddingsTokens")).toHaveTextContent("Memory indexing250K of 2M tokens");
  });

  it("shows the credit balance, what credits paid for this week, and a Top up to the portal", async () => {
    stubUsage(weeklyAnswer("pro"));
    render(<ClawboxAiUsageCard />);
    const credits = await screen.findByTestId("clawai-usage-credits");
    expect(within(credits).getByTestId("clawai-usage-credits-balance")).toHaveTextContent("€12.50");
    expect(within(credits).getByTestId("clawai-usage-credits-used")).toHaveTextContent("€1.20");
    expect(credits).toHaveTextContent("Used from credits this week");
    const topUp = within(credits).getByTestId("clawai-usage-top-up");
    expect(topUp).toHaveAttribute("href", "https://clawbox.com/portal/credits");
    expect(topUp).toHaveAttribute("target", "_blank");
    expect(screen.queryByTestId("clawai-usage-upgrade")).toBeNull();

    const offer = screen.getByTestId("clawai-usage-yearly-offer");
    expect(offer).toHaveTextContent("Save 18% with yearly billing");
    expect(offer).toHaveAttribute("href", "https://clawbox.com/portal/dashboard#subscription");
  });

  it("does not offer yearly billing to a subscriber who already has it", async () => {
    stubUsage(weeklyAnswer("max", { billingInterval: "year" }));
    render(<ClawboxAiUsageCard />);
    await screen.findByTestId("clawai-usage-credits");
    expect(screen.queryByTestId("clawai-usage-yearly-offer")).toBeNull();
  });

  it("says a window could not be read instead of drawing it empty", async () => {
    const answer = weeklyAnswer("pro");
    answer.usage.weekly = { ...answer.usage.weekly, used: 0, percentUsed: 0, unavailable: true };
    answer.usage.credits = { ...answer.usage.credits, unavailable: true };
    stubUsage(answer);
    render(<ClawboxAiUsageCard />);
    const weekly = await screen.findByTestId("clawai-usage-weekly");
    expect(weekly).toHaveTextContent("Not available right now");
    expect(within(weekly).queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("clawai-usage-credits-balance")).toHaveTextContent("Not available right now");
  });

  it("draws no percentage, bar or clock beside a window that is not in the plan", async () => {
    const answer = weeklyAnswer("pro");
    answer.usage.burst = { ...answer.usage.burst, limit: 0, percentUsed: 40 };
    stubUsage(answer);
    render(<ClawboxAiUsageCard />);
    const burst = await screen.findByTestId("clawai-usage-burst");
    expect(burst).toHaveTextContent("Not in your plan");
    expect(within(burst).queryByRole("progressbar")).toBeNull();
    expect(burst).not.toHaveTextContent("Frees up");
  });

  it("writes the numbers and the clock in the owner's language", async () => {
    lang.locale = "de";
    stubUsage(weeklyAnswer("pro"));
    render(<ClawboxAiUsageCard />);
    const card = await screen.findByTestId("clawai-usage-card");
    await vi.waitFor(() => expect(card).toHaveAttribute("data-shape", "weekly"));
    expect(card).toHaveTextContent(translations.de["clawaiUsage.weeklyTitle"]);
    expect(screen.getByTestId("clawai-usage-credits-balance").textContent).toMatch(/12,50\s€/);
    expect(screen.getByTestId("clawai-usage-yearly-offer")).toHaveTextContent("Sparen Sie 18 % mit jährlicher Abrechnung");
  });
});

describe("ClawBox AI usage card — legacy payload", () => {
  it("renders an older portal's daily fields as sent, and nothing it did not send", async () => {
    stubUsage({
      available: true,
      timeZone: "UTC",
      usage: {
        shape: "legacy",
        plan: "pro",
        tierDisplayName: "Pro",
        legacy: { percentUsed: 37, resetIn: "4h 30m", isOverLimit: false, tier: "pro", tierDisplayName: "Pro", buckets: {} },
      },
      percentUsed: 37,
      resetIn: "4h 30m",
      isOverLimit: false,
      tier: "pro",
      tierDisplayName: "Pro",
      buckets: {},
    });
    render(<ClawboxAiUsageCard />);
    const card = await screen.findByTestId("clawai-usage-card");
    await vi.waitFor(() => expect(card).toHaveAttribute("data-shape", "legacy"));
    expect(card).toHaveTextContent("Today's usage");
    expect(card).toHaveTextContent("37% used");
    expect(card).toHaveTextContent("Resets in 4h 30m");
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    for (const absent of ["clawai-usage-weekly", "clawai-usage-burst", "clawai-usage-meters", "clawai-usage-credits", "clawai-usage-upgrade", "clawai-usage-yearly-offer"]) {
      expect(screen.queryByTestId(absent), absent).toBeNull();
    }
  });

  it("says when an older portal reports today's limit reached", async () => {
    stubUsage({
      available: true,
      usage: {
        shape: "legacy",
        plan: "free",
        tierDisplayName: "Free",
        legacy: { percentUsed: 100, resetIn: "45m", isOverLimit: true, tier: "free", tierDisplayName: "Free", buckets: null },
      },
    });
    render(<ClawboxAiUsageCard />);
    expect(await screen.findByText("Today's limit is reached.")).toBeInTheDocument();
  });
});

describe("ClawBox AI usage card — Free plan", () => {
  it("offers Upgrade instead of credits, and no yearly billing", async () => {
    stubUsage(weeklyAnswer("free"));
    render(<ClawboxAiUsageCard />);
    const upgrade = await screen.findByTestId("clawai-usage-upgrade");
    expect(screen.getByTestId("clawai-usage-card")).toHaveTextContent("Free plan");
    const link = within(upgrade).getByRole("link", { name: /Upgrade/ });
    expect(link).toHaveAttribute("href", "https://clawbox.com/portal/dashboard#subscription");
    expect(screen.queryByTestId("clawai-usage-credits")).toBeNull();
    expect(screen.queryByTestId("clawai-usage-top-up")).toBeNull();
    expect(screen.queryByTestId("clawai-usage-yearly-offer")).toBeNull();
    // The allowance itself is still shown on Free.
    expect(screen.getByTestId("clawai-usage-weekly")).toHaveTextContent("Weekly chat allowance");
  });
});

describe("ClawBox AI usage card — nothing to draw", () => {
  it("stays away on a box with no ClawBox AI credential", async () => {
    const fetchSpy = stubUsage({ available: false, reason: "not_connected" });
    const { container } = render(<ClawboxAiUsageCard />);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector("[data-testid='clawai-usage-card']")).toBeNull());
  });

  it("points at the portal when it will not share usage with this box", async () => {
    stubUsage({ available: false, reason: "refused" });
    render(<ClawboxAiUsageCard />);
    const note = await screen.findByTestId("clawai-usage-unavailable");
    expect(note).toHaveTextContent("does not share usage details with this box yet");
    expect(screen.getByRole("link", { name: /Open clawbox.com/ })).toHaveAttribute("href", "https://clawbox.com/portal/dashboard");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says a failed load is a moment, not a verdict", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<ClawboxAiUsageCard />);
    expect(await screen.findByTestId("clawai-usage-unavailable")).toHaveTextContent("could not be loaded right now");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
