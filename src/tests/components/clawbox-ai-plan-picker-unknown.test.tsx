/**
 * The ClawBox AI plan summary, before the box knows what the account is on.
 *
 * The picker is seeded from local storage, and local storage falls back to the
 * internal tier "flash" — the plan marketed as Pro. So on a box that had never
 * stored a tier the card announced "Pro plan · €9/month" as a statement of
 * fact, on hardware whose own portal page said Max. It is not a reading of the
 * subscription until something has actually read the subscription, so until
 * then it says where the plan comes from and names none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ClawboxAiPlanPicker from "@/components/ClawboxAiPlanPicker";
import { translations } from "@/lib/translations";

const pack = vi.hoisted(() => ({ table: null as Record<string, string> | null }));

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "en",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string) => pack.table?.[key] ?? key,
  }),
}));

beforeEach(() => { pack.table = translations.en; });

const summary = () => screen.getByTestId("clawai-plan-summary");

describe("the plan summary claims nothing before the account is known", () => {
  it("names no plan and no price while the box is unconnected", () => {
    // "flash" is the seeded default, and the exact value that used to be
    // printed as the owner's plan.
    render(<ClawboxAiPlanPicker tier="flash" onTierChange={vi.fn()} planKnown={false} />);

    expect(summary()).toHaveTextContent(translations.en["ai.planFromAccount"]);
    expect(screen.queryByText(/Pro plan/)).toBeNull();
    expect(screen.queryByText(/€9/)).toBeNull();
  });

  it("says the same for a seeded Max, so it is the claim that is withheld, not one tier", () => {
    render(<ClawboxAiPlanPicker tier="pro" onTierChange={vi.fn()} planKnown={false} />);

    expect(summary()).toHaveTextContent(translations.en["ai.planFromAccount"]);
    expect(screen.queryByText(/Max plan · €49\/month/)).toBeNull();
  });

  it("still opens the tiers, so a plan is one tap away", () => {
    render(<ClawboxAiPlanPicker tier="flash" onTierChange={vi.fn()} planKnown={false} />);

    expect(screen.getByRole("button", { name: /Change/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("names the real plan the moment the account is known", () => {
    render(<ClawboxAiPlanPicker tier="pro" onTierChange={vi.fn()} planKnown />);

    expect(summary()).toHaveTextContent("Max plan · €49/month");
    expect(screen.queryByText(translations.en["ai.planFromAccount"])).toBeNull();
  });

  it("defaults to naming the plan, so a caller that knows needs no ceremony", () => {
    render(<ClawboxAiPlanPicker tier="flash" onTierChange={vi.fn()} />);

    expect(summary()).toHaveTextContent("Pro plan · €9/month");
  });

  it("speaks the UI language rather than an English fallback", () => {
    pack.table = translations.de;
    render(<ClawboxAiPlanPicker tier="flash" onTierChange={vi.fn()} planKnown={false} />);

    expect(summary()).toHaveTextContent(translations.de["ai.planFromAccount"]);
    expect(summary()).not.toHaveTextContent(translations.en["ai.planFromAccount"]);
  });

  it("wraps the neutral line instead of clipping it", () => {
    // Caught by looking at it: the summary carried `truncate`, which is fine
    // for a two-word plan name and not for a sentence. In the settings column
    // German rendered "Der Tarif wird aus Ihrem Konto übernomm…" — the message
    // that replaced a wrong claim, cut off mid-word. It must wrap.
    pack.table = translations.de;
    render(<ClawboxAiPlanPicker tier="flash" onTierChange={vi.fn()} planKnown={false} />);

    const cls = summary().className;
    expect(cls, "truncate hides the end of the longest locale").not.toContain("truncate");
    expect(cls).toContain("break-words");
  });
});
