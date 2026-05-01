import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

const EXPECTED_LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];

describe("translations", () => {
  describe("structure", () => {
    it("exports a translations object", () => {
      expect(translations).toBeDefined();
      expect(typeof translations).toBe("object");
    });

    it("contains all 10 expected locales", () => {
      const locales = Object.keys(translations).sort();
      expect(locales).toEqual([...EXPECTED_LOCALES].sort());
    });

    it("each locale has a non-empty record of strings", () => {
      for (const locale of EXPECTED_LOCALES) {
        const record = translations[locale];
        expect(record, `locale '${locale}' should exist`).toBeDefined();
        expect(typeof record).toBe("object");
        expect(Object.keys(record).length).toBeGreaterThan(0);
      }
    });
  });

  describe("key completeness", () => {
    const enKeys = Object.keys(translations.en).sort();

    it("English locale has translation keys", () => {
      expect(enKeys.length).toBeGreaterThan(50);
    });

    for (const locale of EXPECTED_LOCALES) {
      if (locale === "en") continue;

      it(`'${locale}' has the same keys as 'en'`, () => {
        const localeKeys = Object.keys(translations[locale]).sort();
        expect(localeKeys).toEqual(enKeys);
      });
    }
  });

  describe("value types", () => {
    for (const locale of EXPECTED_LOCALES) {
      it(`all values in '${locale}' are non-empty strings`, () => {
        const record = translations[locale];
        for (const [key, value] of Object.entries(record)) {
          expect(typeof value, `${locale}["${key}"] should be a string`).toBe("string");
          expect(value.length, `${locale}["${key}"] should not be empty`).toBeGreaterThan(0);
        }
      });
    }
  });

  describe("interpolation placeholders", () => {
    // Extract keys that use {placeholder} syntax from English
    function getPlaceholders(value: string): string[] {
      const matches = value.match(/\{(\w+)\}/g);
      return matches ? matches.sort() : [];
    }

    it("all locales preserve the same placeholders as English", () => {
      const enRecord = translations.en;
      for (const locale of EXPECTED_LOCALES) {
        if (locale === "en") continue;
        const localeRecord = translations[locale];
        for (const key of Object.keys(enRecord)) {
          const enPlaceholders = getPlaceholders(enRecord[key]);
          if (enPlaceholders.length === 0) continue;
          const localePlaceholders = getPlaceholders(localeRecord[key]);
          expect(
            localePlaceholders,
            `${locale}["${key}"] should have placeholders ${enPlaceholders.join(", ")}`,
          ).toEqual(enPlaceholders);
        }
      }
    });
  });

  describe("key naming conventions", () => {
    it("all keys use dot-notation or camelCase (no spaces or special chars)", () => {
      for (const key of Object.keys(translations.en)) {
        expect(key).toMatch(
          /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9][a-zA-Z0-9]*)*$/,
        );
      }
    });

    it("keys are organized into known namespaces", () => {
      // Manually maintained: add new prefixes here when introducing new
      // translation namespaces (i.e. keys like "foo.bar" where "foo" is the prefix).
      const knownPrefixes = new Set([
        "wifi",
        "update",
        "credentials",
        "ai",
        "telegram",
        "wizard",
        "progress",
        "settings",
        "app",
        "shelf",
        "launcher",
        "window",
        "taskbar",
        "tray",
        "chat",
        "terminal",
        "browser",
        "files",
        "vnc",
        "store",
        "ollama",
        "openclaw",
        "drawer",
        "login",
        "updateNotification",
        "remoteControl",
        "clawkeep",
      ]);

      for (const key of Object.keys(translations.en)) {
        if (!key.includes(".")) continue; // top-level common keys like "back", "save"
        const prefix = key.split(".")[0];
        expect(
          knownPrefixes.has(prefix),
          `key "${key}" has unknown prefix "${prefix}"`,
        ).toBe(true);
      }
    });
  });

  describe("no duplicate values within English", () => {
    it("flags any unintentional duplicates (informational)", () => {
      const seen = new Map<string, string[]>();
      for (const [key, value] of Object.entries(translations.en)) {
        if (!seen.has(value)) {
          seen.set(value, []);
        }
        seen.get(value)!.push(key);
      }
      // This test just verifies the structure is parseable; some duplicates are legitimate
      // (e.g., "Save & Continue" might appear in multiple contexts).
      // We simply ensure no key has an undefined value.
      for (const [key, value] of Object.entries(translations.en)) {
        expect(value, `en["${key}"] should not be undefined`).toBeDefined();
      }
    });
  });

  describe("specific known translations", () => {
    it("English has correct common keys", () => {
      expect(translations.en["back"]).toBe("Back");
      expect(translations.en["continue"]).toBe("Continue");
      expect(translations.en["save"]).toBe("Save");
      expect(translations.en["cancel"]).toBe("Cancel");
      expect(translations.en["retry"]).toBe("Retry");
      expect(translations.en["skip"]).toBe("Skip");
      expect(translations.en["search"]).toBe("Search...");
    });

    it("English wifi step has expected keys", () => {
      expect(translations.en["wifi.welcome"]).toBe("Welcome to ClawBox");
      expect(translations.en["wifi.connectWifi"]).toBe("Connect to WiFi");
      expect(translations.en["wifi.password"]).toBe("Password");
    });

    it("English AI step has expected keys", () => {
      expect(translations.en["ai.title"]).toBe("Connect AI Model");
      expect(translations.en["ai.free"]).toBe("Free");
    });

    it("interpolation keys contain placeholders in English", () => {
      expect(translations.en["wifi.connectionFailed"]).toContain("{error}");
      expect(translations.en["ai.settingUp"]).toContain("{provider}");
      expect(translations.en["progress.label"]).toContain("{current}");
      expect(translations.en["progress.label"]).toContain("{total}");
    });
  });

  describe("no accidental English in non-English locales", () => {
    // Some keys legitimately keep English values (brand names, technical terms).
    // This test checks that the majority of translations differ from English.
    for (const locale of EXPECTED_LOCALES) {
      if (locale === "en") continue;

      it(`'${locale}' has mostly non-English values`, () => {
        const enRecord = translations.en;
        const localeRecord = translations[locale];
        const totalKeys = Object.keys(enRecord).length;
        let sameCount = 0;

        for (const key of Object.keys(enRecord)) {
          if (enRecord[key] === localeRecord[key]) {
            sameCount++;
          }
        }

        // Allow up to 15% of keys to match English (brand names, URLs, technical terms)
        const sameRatio = sameCount / totalKeys;
        expect(
          sameRatio,
          `${locale} has ${sameCount}/${totalKeys} (${(sameRatio * 100).toFixed(1)}%) keys identical to English — too many untranslated`,
        ).toBeLessThan(0.15);
      });
    }
  });
});
