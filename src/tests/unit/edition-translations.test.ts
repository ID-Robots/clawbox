import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import { editionEn } from "@/lib/edition-translations";
import { settingsSecurityEn } from "@/lib/edition-translations/en-settings-security";
import { providerEn } from "@/lib/edition-translations/en-provider";
import { skillsEn } from "@/lib/edition-translations/en-skills";
import { localModelsEn } from "@/lib/edition-translations/en-local-models";
import { systemProfileEn } from "@/lib/edition-translations/en-system-profile";
import { codingAgentEn } from "@/lib/edition-translations/en-coding-agent";
import { shellScanEn } from "@/lib/edition-translations/en-shell-scan";
import { bg } from "@/lib/edition-translations/bg";
import { de } from "@/lib/edition-translations/de";
import { es } from "@/lib/edition-translations/es";
import { fr } from "@/lib/edition-translations/fr";
import { it as itLocale } from "@/lib/edition-translations/it";
import { ja } from "@/lib/edition-translations/ja";
import { nl } from "@/lib/edition-translations/nl";
import { sv } from "@/lib/edition-translations/sv";
import { zh } from "@/lib/edition-translations/zh";
import type { Locale } from "@/lib/i18n";

/**
 * TASK-458. Four surfaces — the system-password card, the Hermes provider
 * picker, the Skills store and the Local Models tab — rendered hardcoded
 * English on every box regardless of locale, in one case directly beside a
 * `t("cancel")` that WAS translated.
 *
 * `translations.test.ts` could not have caught it: it only compares locale
 * tables to each other, and a string that never entered the catalogue is
 * invisible to that comparison. So this file asserts the property that
 * actually broke — for every key of this pass, every locale carries copy of
 * its OWN, checked against the per-locale override module rather than the
 * merged table (the merge layers English underneath as a runtime safety net,
 * which would mask exactly the regression under test).
 */

const OVERRIDES: Record<Exclude<Locale, "en">, Record<string, string>> = {
  bg, de, es, fr, it: itLocale, ja, nl, sv, zh,
};

const NON_EN = Object.keys(OVERRIDES) as Exclude<Locale, "en">[];

/** The surfaces this catalogue covers, by key prefix. */
const NAMESPACES: { name: string; matches: (key: string) => boolean }[] = [
  { name: "security/password forms", matches: (k) => k.startsWith("settings.security.") },
  { name: "Hermes provider UI", matches: (k) => k.startsWith("hermesProvider.") },
  { name: "Skills store", matches: (k) => k.startsWith("skills.") },
  { name: "Local Models tab", matches: (k) => k.startsWith("localModels.") },
  // Desktop & power card (TASK-455). Held to exactly the same bar as the
  // TASK-458 four: every locale carries its own copy, not an English fallback.
  { name: "Desktop & power card", matches: (k) => k.startsWith("systemProfile.") },
  // Coding agent card: the owner's switch for delegated Claude Code runs.
  { name: "Coding agent card", matches: (k) => k.startsWith("codingAgent.") },
  // Pre-exec shell scanning notice (HERMES-08) — the box's only statement that
  // a security control is off. An owner who cannot read it is not warned.
  { name: "Shell scanning notice", matches: (k) => k.startsWith("shellScan.") },
];

/**
 * Values a locale may legitimately keep byte-identical to English: bare brand
 * and product names, and nothing else. A value only qualifies if the ENTIRE
 * string is one of these — "Hermes" passes, "Sign in with Hermes" does not.
 *
 * Locale-specific rather than global: Bulgarian, Japanese and Chinese keep
 * Latin-script brand names the way their existing blocks in
 * desktop-translations already do, but that is a per-locale convention, not a
 * licence for any locale to skip a sentence.
 */
const BRAND_ONLY = new Set([
  "ClawBox", "ClawKeep", "OpenClaw", "Hermes", "Ollama", "Telegram",
  "OAuth", "API", "SSH", "sudo", "CLI", "LAN", "WiFi",
  "Pro", "Max", "Free", "ClawBox AI", "Hermes CLI", "macOS", "Windows", "Linux",
  "Linux/macOS", "SKILL.md", "Disk", "Memory",
  "Claude Code", "claude-ds",
  // Claude Code's own name for its xhigh-plus-workflows mode (`--effort
  // ultracode`); the label matches what the terminal prints.
  "Ultracode",
  // A loanword that is genuinely identical in several languages.
  "tokens",
  // A filesystem path shown as a placeholder. Translating it would invent a
  // folder that does not exist on the box.
  "/home/clawbox/Projects",
]);

function untranslated(locale: Exclude<Locale, "en">, keys: string[]): string[] {
  const table = OVERRIDES[locale];
  return keys.filter((key) => {
    const value = table[key];
    if (value === undefined) return false; // reported by the completeness test
    if (value !== editionEn[key]) return false;
    // A value that is nothing but placeholders ("{model}") has no words to
    // translate, so it is identical in every locale by construction.
    if (/^(\s*\{\w+\}\s*)+$/.test(value)) return false;
    return !BRAND_ONLY.has(value.trim());
  });
}

describe("edition-translations (TASK-458)", () => {
  describe("the English catalogue covers every surface", () => {
    const surfaces: [string, Record<string, string>, (k: string) => boolean][] = [
      ["settingsSecurityEn", settingsSecurityEn, (k) => k.startsWith("settings.")],
      ["providerEn", providerEn, (k) => k.startsWith("hermesProvider.")],
      ["skillsEn", skillsEn, (k) => k.startsWith("skills.")],
      ["localModelsEn", localModelsEn, (k) => k.startsWith("localModels.")],
      ["systemProfileEn", systemProfileEn, (k) => k.startsWith("systemProfile.")],
      ["codingAgentEn", codingAgentEn, (k) => k.startsWith("codingAgent.")],
      ["shellScanEn", shellScanEn, (k) => k.startsWith("shellScan.")],
    ];

    for (const [name, table, prefixed] of surfaces) {
      it(`${name} is non-empty and stays inside its namespace`, () => {
        const keys = Object.keys(table);
        expect(keys.length, `${name} should carry the surface's copy`).toBeGreaterThan(5);
        expect(keys.filter((k) => !prefixed(k)), `${name} has stray keys`).toEqual([]);
      });
    }

    it("the surface modules do not collide", () => {
      const counts = surfaces.reduce((n, [, table]) => n + Object.keys(table).length, 0);
      expect(Object.keys(editionEn).length).toBe(counts);
    });

    it("is reachable through the merged catalogue the UI actually reads", () => {
      for (const key of Object.keys(editionEn)) {
        expect(translations.en[key], `en["${key}"] missing from the merged table`).toBe(editionEn[key]);
      }
    });
  });

  describe.each(NAMESPACES)("$name", ({ matches }) => {
    const keys = Object.keys(editionEn).filter(matches);

    it("has English copy", () => {
      expect(keys.length).toBeGreaterThan(5);
    });

    // The lane's headline requirement: no key of these namespaces may be
    // missing from Bulgarian. Every other locale is held to the same bar —
    // "the all-locales rule".
    for (const locale of NON_EN) {
      it(`'${locale}' translates every key`, () => {
        const table = OVERRIDES[locale];
        const missing = keys.filter((k) => typeof table[k] !== "string" || table[k].length === 0);
        expect(missing, `${locale} is missing ${missing.length} key(s)`).toEqual([]);
      });

      it(`'${locale}' leaves no key in English`, () => {
        const english = untranslated(locale, keys);
        expect(
          english,
          `${locale} still renders English for ${english.length} key(s)`,
        ).toEqual([]);
      });
    }
  });

  describe("locale tables carry no keys English does not have", () => {
    for (const locale of NON_EN) {
      it(`'${locale}' has no orphan keys`, () => {
        const orphans = Object.keys(OVERRIDES[locale]).filter((k) => !(k in editionEn));
        expect(orphans, `${locale} has keys with no English source`).toEqual([]);
      });
    }
  });

  describe("placeholders survive translation", () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();

    for (const locale of NON_EN) {
      it(`'${locale}' preserves every {placeholder}`, () => {
        for (const [key, source] of Object.entries(editionEn)) {
          const expected = placeholders(source);
          if (expected.length === 0) continue;
          const value = OVERRIDES[locale][key];
          if (value === undefined) continue; // reported by the completeness test
          expect(
            placeholders(value),
            `${locale}["${key}"] must keep ${expected.join(" ")}`,
          ).toEqual(expected);
        }
      });
    }
  });

  /**
   * The other half of the finding: key parity across the pre-existing
   * catalogue was already perfect, but one recent feature shipped its English
   * values verbatim into all nine locales. Pin those keys so the next upsell
   * string cannot ride in the same way.
   */
  describe("the upgrade / ClawKeep block is translated everywhere", () => {
    const KEYS = [
      "shelf.clawkeepNeedsPaid",
      "upgradeCard.needsPaidPlan",
      "upgradeCard.subscribeButton",
      "upgradeCard.trialBannerHeadline",
      "upgradeCard.trialBannerSubtitle",
      "upgradeCard.startFreeTrial",
      "clawkeep.upgrade.featureName",
      "clawkeep.upgrade.description",
      "remoteControl.upgrade.featureName",
      "remoteControl.upgrade.description",
    ];

    it("English defines every key", () => {
      for (const key of KEYS) {
        expect(translations.en[key], `en["${key}"] should exist`).toBeTruthy();
      }
    });

    for (const locale of NON_EN) {
      it(`'${locale}' does not fall back to English`, () => {
        const english = KEYS.filter((k) => translations[locale][k] === translations.en[k]);
        expect(english, `${locale} still shows English upsell copy`).toEqual([]);
      });
    }
  });
});
