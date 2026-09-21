import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ClawboxAiPlanPicker from "@/components/ClawboxAiPlanPicker";
import { CLAWAI_TIER_INFO } from "@/lib/clawbox-ai-tiers";
import { translations } from "@/lib/translations";

// A German box, resolved out of the shipped catalogue: the fix is that this
// card reads the SAME table as the page around it, so a key that never reached
// `de` must fail here rather than quietly fall back to English on the device.
// The table is swappable so the last case can render a pack that knows nothing.
const pack = vi.hoisted(() => ({ table: null as Record<string, string> | null }));

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string) => pack.table?.[key] ?? key,
  }),
}));

beforeEach(() => { pack.table = translations.de; });

/**
 * The whole ClawBox AI plan card was English literals: "Plan", "Max plan ·
 * €49/month", "Change", the Max blurb, "Tier", "Trial" and every feature
 * bullet, on a box whose Settings sidebar was in German. The price and the
 * plan name are the two facts an owner has to read before pressing Connect.
 */
describe("ClawBox AI plan card speaks the UI language", () => {
  it("states the plan and its price in German on the closed summary", () => {
    render(<ClawboxAiPlanPicker tier="pro" onTierChange={vi.fn()} />);

    expect(screen.getByText("Tarif")).toBeInTheDocument();
    expect(screen.getByText("Max-Tarif · €49/Monat")).toBeInTheDocument();
    expect(screen.getByText("Ändern")).toBeInTheDocument();
    expect(screen.queryByText(/Max plan · €49\/month/)).toBeNull();
  });

  it("says 'free forever' in German rather than a €0 price", () => {
    render(<ClawboxAiPlanPicker tier="free" onTierChange={vi.fn()} />);
    expect(screen.getByText("Free-Tarif · für immer kostenlos")).toBeInTheDocument();
  });

  it("translates the blurb, the tier control and every feature bullet", () => {
    render(<ClawboxAiPlanPicker tier="pro" onTierChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tarif/ }));

    expect(screen.getByText(translations.de["ai.planBlurb"])).toBeInTheDocument();
    expect(screen.getByText("Stufe")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "ClawBox-AI-Stufe" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Stufe Max, Testphase" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Stufe Free" })).toBeInTheDocument();
    expect(screen.getByText("30 Tage kostenlos testen")).toBeInTheDocument();

    for (const key of CLAWAI_TIER_INFO.pro.featureKeys) {
      expect(screen.getByText(translations.de[key])).toBeInTheDocument();
    }
    // The English bullets must be gone, not merely outnumbered.
    expect(screen.queryByText("Maximum usage")).toBeNull();
    expect(screen.queryByText("Highest priority")).toBeNull();
  });

  it("falls back to the English floor when a locale pack has not reached a key", () => {
    // `t()` answers with the raw key for a key it does not know, and
    // "ai.planNameMax" on the price line would be worse than the English
    // sentence it replaced — so the card keeps English as its floor.
    pack.table = {};
    render(<ClawboxAiPlanPicker tier="pro" onTierChange={vi.fn()} />);

    expect(screen.getByText("Max plan · €49/month")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.queryByText(/ai\.plan/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
    expect(screen.getByText("Maximum usage")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Max tier, Trial" })).toBeInTheDocument();
  });
});
