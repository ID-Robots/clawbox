import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

const LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];

/**
 * The Ultracode cost note in the Coding Agent wizard recommended "a Business
 * plan". ClawBox AI has never sold one: the plans are Free, Pro and Max, and
 * the heaviest effort level is a recommendation for the top paid plan. An
 * owner who went looking for the plan this sentence named found nothing, in
 * every language — the string had been translated faithfully into all ten.
 */
describe("the Ultracode cost note names a plan that exists", () => {
  for (const locale of LOCALES) {
    it(`'${locale}' recommends Max and never a Business plan`, () => {
      const copy = translations[locale]["codingAgent.wizardEffortCost"];
      expect(copy, `${locale} is missing the cost note`).toBeTruthy();
      expect(copy, `${locale} still names a Business plan`).not.toMatch(/business/i);
      expect(copy, `${locale} does not name the Max plan`).toMatch(/Max/);
    });
  }

  it("names no plan ClawBox AI does not sell, anywhere in the wizard copy", () => {
    // The wizard is where an owner is told what a feature costs, so a plan
    // name invented here is the most expensive kind of typo.
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(translations[locale])) {
        if (!key.startsWith("codingAgent.")) continue;
        expect(value, `${locale}["${key}"] names a Business plan`).not.toMatch(/business/i);
      }
    }
  });
});
