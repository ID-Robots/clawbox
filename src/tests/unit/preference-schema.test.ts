import { describe, expect, it } from "vitest";
import {
  MAX_PREFERENCE_STRING_LENGTH,
  PREFERENCE_LANGUAGES,
  isPreferenceLanguage,
  sanitizePreferences,
  validatePreference,
} from "@/lib/preference-schema";

describe("preference-schema", () => {
  describe("ui_language closed domain", () => {
    it("accepts every locale the device ships", () => {
      for (const lang of PREFERENCE_LANGUAGES) {
        expect(validatePreference("ui_language", lang).ok).toBe(true);
      }
    });

    it("rejects a locale the device does not ship", () => {
      const check = validatePreference("ui_language", "klingon");
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("ui_language");
    });

    it("rejects a locale carrying trailing prose", () => {
      // The shape a valid code plus appended text takes: the prefix is real,
      // everything after the newline is not a locale.
      const check = validatePreference("ui_language", "de\n## Heading\nsentence");
      expect(check.ok).toBe(false);
    });

    it("rejects a non-string locale", () => {
      expect(validatePreference("ui_language", 42).ok).toBe(false);
      expect(validatePreference("ui_language", ["de"]).ok).toBe(false);
      expect(validatePreference("ui_language", null).ok).toBe(false);
    });

    it("isPreferenceLanguage narrows the same set", () => {
      expect(isPreferenceLanguage("bg")).toBe(true);
      expect(isPreferenceLanguage("xx")).toBe(false);
      expect(isPreferenceLanguage(7)).toBe(false);
    });
  });

  describe("wp_fit closed domain", () => {
    it("accepts the fit modes the desktop uses", () => {
      for (const fit of ["fill", "fit", "center"]) {
        expect(validatePreference("wp_fit", fit).ok).toBe(true);
      }
    });

    it("rejects anything else", () => {
      expect(validatePreference("wp_fit", "stretch").ok).toBe(false);
    });
  });

  describe("general bound on keys with no declared domain", () => {
    it("accepts the live desktop state the UI round-trips", () => {
      expect(validatePreference("wp_opacity", 80).ok).toBe(true);
      expect(validatePreference("wp_bg_color", "#111").ok).toBe(true);
      expect(validatePreference("installed_apps", []).ok).toBe(true);
      expect(validatePreference("ui_mascot_hidden", 1).ok).toBe(true);
      expect(validatePreference("ui_e2e_probe", null).ok).toBe(true);
      expect(
        validatePreference("icon_grid", { "desktop-settings": { row: 0, col: 0 } }).ok,
      ).toBe(true);
      expect(
        validatePreference("desktop_open_windows", [
          { appId: "vnc", minimized: true, x: 460, y: 77.5, width: 1000, height: 700 },
        ]).ok,
      ).toBe(true);
    });

    it("rejects a multi-line string under any key", () => {
      const check = validatePreference("ui_user_name", "Alice\n## Heading\nsentence");
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("control characters");
    });

    it("rejects control characters nested inside structured values", () => {
      expect(validatePreference("installed_apps", ["ok", "bad\nvalue"]).ok).toBe(false);
      expect(validatePreference("pinned_apps", { a: "bad\rvalue" }).ok).toBe(false);
      expect(validatePreference("pinned_apps", { "bad\nkey": "ok" }).ok).toBe(false);
    });

    it("rejects an oversized string", () => {
      const check = validatePreference("ui_theme", "x".repeat(MAX_PREFERENCE_STRING_LENGTH + 1));
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("longer than");
    });

    it("rejects a non-finite number and a non-JSON value", () => {
      expect(validatePreference("wp_opacity", Number.NaN).ok).toBe(false);
      expect(validatePreference("wp_opacity", Number.POSITIVE_INFINITY).ok).toBe(false);
      expect(validatePreference("ui_thing", () => "x").ok).toBe(false);
    });

    it("rejects a value nested past the depth cap instead of recursing forever", () => {
      const cyclic: Record<string, unknown> = { name: "loop" };
      cyclic.self = cyclic;
      const check = validatePreference("desktop_windows", cyclic);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("nested too deeply");
    });
  });

  describe("sanitizePreferences", () => {
    it("drops only the entries that fail validation", () => {
      const out = sanitizePreferences({
        ui_language: "de\n## Heading\nsentence",
        wp_opacity: 80,
        ui_user_name: "Alice",
      });
      expect(out).toEqual({ wp_opacity: 80, ui_user_name: "Alice" });
      expect(out).not.toHaveProperty("ui_language");
    });

    it("drops undefined so a missing key stays missing", () => {
      expect(sanitizePreferences({ ui_language: undefined })).toEqual({});
    });
  });
});
