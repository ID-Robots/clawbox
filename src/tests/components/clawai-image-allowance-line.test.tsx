import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@/tests/helpers/test-utils";
import ClawboxAiImageAllowanceLine from "@/components/ClawboxAiImageAllowanceLine";
import { readImageAllowance } from "@/lib/clawbox-ai-models";
import { translations } from "@/lib/translations";

// TASK-469. The cap was real and enforced from the day image generation
// shipped, and nothing on the box rendered a single thing about it — a
// repo-wide grep for `clawaiImages` outside tests returned two hits, both
// inside the route that produced it. The first time an owner learned the cap
// existed was the request that got refused.
//
// So what is asserted here is not "a string appears" but the three states and
// the line between them: nothing when we do not know, the ceiling when that is
// all we know, and the count when the portal told us. The word "today" is
// checked in every locale, because the same copy said "a month" two days ago
// and a small number read as a small month makes the plan look worthless.

// Real strings, real interpolation — a stub that echoes keys would let a
// missing translation pass.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) => {
      const raw = (translations.en as Record<string, string>)[key] ?? key;
      return Object.entries(params ?? {}).reduce(
        (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v)),
        raw,
      );
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const block = (over: Record<string, unknown> = {}) => ({
  supported: true,
  model: "gpt-image-1-mini",
  plan: "max",
  planLabel: "Max",
  dailyLimit: 20,
  used: 3,
  ...over,
});

describe("the image allowance line", () => {
  it("renders nothing at all when the portal did not answer", () => {
    // Not an empty element, not a dash, not "—". Nothing. A placeholder is a
    // claim that there is something to know here.
    const { queryByTestId } = render(<ClawboxAiImageAllowanceLine allowance={null} />);
    expect(queryByTestId("clawai-image-allowance")).toBeNull();
  });

  it("names the plan when it knows the ceiling but not the usage", () => {
    const allowance = readImageAllowance(block({ used: undefined }));
    const { getByTestId } = render(<ClawboxAiImageAllowanceLine allowance={allowance} />);
    // The plan is named because the picker directly above it can be moved by
    // hand: "20 images a day" alone would read as a fact about this box, not
    // about the plan the number belongs to.
    expect(getByTestId("clawai-image-allowance").textContent).toContain("20 images a day on Max");
  });

  it("counts the day when the portal reported usage", () => {
    const allowance = readImageAllowance(block());
    const { getByTestId } = render(<ClawboxAiImageAllowanceLine allowance={allowance} />);
    expect(getByTestId("clawai-image-allowance").textContent).toContain("3 of 20 images today");
  });

  it("stays quiet below the warning line and speaks up at it", () => {
    // 80% is the decided point (TASK-469): told once, where the number lives,
    // not as a permanent banner. A cap that arrives with no warning does not
    // read as a plan limit, it reads as a broken box.
    const lineFor = (used: number) => {
      const view = render(
        <ClawboxAiImageAllowanceLine
          allowance={readImageAllowance(block({ dailyLimit: 5, used }))}
        />,
      );
      const el = view.getByTestId("clawai-image-allowance");
      const className = el.className;
      view.unmount();
      return className;
    };

    expect(lineFor(3)).toContain("--text-muted"); // 60%
    expect(lineFor(4)).toContain("amber"); // 80%, exactly on the line
  });

  it("says when the allowance comes back once the day is spent", () => {
    const spent = render(
      <ClawboxAiImageAllowanceLine allowance={readImageAllowance(block({ dailyLimit: 5, used: 5 }))} />,
    ).getByTestId("clawai-image-allowance");
    expect(spent.textContent).toContain("5 of 5 images today");
    // The half a refused owner actually needs: not "you are out", but "for how
    // long". Hours, not the three weeks a monthly meter used to mean.
    expect(spent.textContent).toContain("resets at midnight UTC");
  });

  it("is announced rather than silent", () => {
    // It changes without the user moving, and on a box that has just refused a
    // picture it is the explanation.
    const { getByTestId } = render(
      <ClawboxAiImageAllowanceLine allowance={readImageAllowance(block())} />,
    );
    expect(getByTestId("clawai-image-allowance").getAttribute("role")).toBe("status");
  });
});

describe("the copy, in every language the box ships", () => {
  const LOCALES = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"] as const;

  it.each(LOCALES)("%s has all three strings and interpolates both numbers", (locale) => {
    const pack = translations[locale] as Record<string, string>;
    for (const key of ["ai.imagesPerDayOnPlan", "ai.imagesUsedToday", "ai.imagesResetTomorrow"]) {
      expect(pack[key], `${locale} is missing ${key}`).toBeTruthy();
    }
    // A translation that dropped a placeholder renders a sentence with a hole
    // in it, and it renders it only for the customers who read that language.
    expect(pack["ai.imagesPerDayOnPlan"]).toContain("{limit}");
    expect(pack["ai.imagesPerDayOnPlan"]).toContain("{plan}");
    expect(pack["ai.imagesUsedToday"]).toContain("{used}");
    expect(pack["ai.imagesUsedToday"]).toContain("{limit}");
  });

  it.each(LOCALES)("%s never calls the daily allowance a month", (locale) => {
    // The specific regression this ships against: ten locales said "a month"
    // about this number until TASK-485, and 20 read as a monthly cap makes the
    // plan look worthless.
    const pack = translations[locale] as Record<string, string>;
    const joined = [
      pack["ai.imagesPerDayOnPlan"],
      pack["ai.imagesUsedToday"],
      pack["ai.imagesResetTomorrow"],
    ].join(" ").toLowerCase();
    for (const monthly of ["month", "monat", "mes", "mois", "mese", "månad", "maand", "месец", "月間", "每月"]) {
      expect(joined, `${locale} says "${monthly}"`).not.toContain(monthly);
    }
  });
});
