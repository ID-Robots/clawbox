import { describe, expect, it } from "vitest";
import {
  MAX_PREFERENCE_STRING_LENGTH,
  PREFERENCE_LANGUAGES,
  boundPreferenceText,
  isPreferenceLanguage,
  sanitizePreferences,
  sanitizePreferenceValue,
  sanitizePreferenceWrites,
  validatePreference,
} from "@/lib/preference-schema";

// Written by code point rather than as a literal: an escape is easy to lose
// in an edit, and a raw control character in a source file is invisible to
// whoever reads it next.
const CONTROL = String.fromCharCode(7);

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

  describe("collections degrade one member at a time", () => {
    // installed_meta is one entry per installed app under a single key. The
    // desktop reads it on mount and writes back what it read, so what this
    // returns for one app decides what is kept for all of them.
    const installedMeta = {
      notes: { name: "Notes", color: "#f97316", iconUrl: "" },
      timer: { name: `Ti${CONTROL}mer`, color: "#f97316", iconUrl: "" },
      radio: { name: "Radio", color: "#22d3ee", iconUrl: "" },
    };

    it("keeps other entries when one is malformed", () => {
      expect(sanitizePreferenceValue("installed_meta", installedMeta)).toEqual({
        ok: true,
        value: {
          notes: { name: "Notes", color: "#f97316", iconUrl: "" },
          radio: { name: "Radio", color: "#22d3ee", iconUrl: "" },
        },
      });
    });

    it("serves the surviving entries through the read path", () => {
      const out = sanitizePreferences({ installed_meta: installedMeta, wp_opacity: 80 });
      expect(Object.keys(out.installed_meta as object)).toEqual(["notes", "radio"]);
      expect(out.wp_opacity).toBe(80);
    });

    it("keeps the good members of a list", () => {
      expect(
        sanitizePreferenceValue("installed_apps", ["notes", `ti${CONTROL}mer`, "radio"]),
      ).toEqual({ ok: true, value: ["notes", "radio"] });
    });

    it("keeps a whole value that already passes", () => {
      const value = { notes: { name: "Notes" } };
      const kept = sanitizePreferenceValue("installed_meta", value);
      expect(kept).toMatchObject({ ok: true });
      // The same object, not a rebuilt copy.
      expect(kept.ok && kept.value).toBe(value);
    });

    it("keeps nothing for a scalar or a closed domain, which have no members", () => {
      expect(sanitizePreferenceValue("ui_user_name", `Ali${CONTROL}ce`).ok).toBe(false);
      expect(sanitizePreferenceValue("ui_language", "de\n## Heading").ok).toBe(false);
    });
  });

  describe("sanitizePreferenceWrites", () => {
    it("checks pref:-prefixed store keys and passes the rest through", () => {
      const out = sanitizePreferenceWrites({
        "pref:installed_apps": ["notes", `ti${CONTROL}mer`],
        "pref:wp_opacity": 80,
      });
      expect(out).toEqual({
        "pref:installed_apps": ["notes"],
        "pref:wp_opacity": 80,
      });
    });

    it("keeps a store key whose value passes unchanged", () => {
      expect(sanitizePreferenceWrites({ "pref:ui_language": "bg" })).toEqual({
        "pref:ui_language": "bg",
      });
    });

    it("leaves keys outside the preference namespace alone", () => {
      // The config store holds tokens and setup flags under the same roof, and
      // the preference rules would be wrong for those.
      const out = sanitizePreferenceWrites({
        clawai_token: `tok${CONTROL}en`,
        ai_model_configured: true,
      });
      expect(out).toEqual({ clawai_token: `tok${CONTROL}en`, ai_model_configured: true });
    });
  });

  describe("boundPreferenceText", () => {
    it("returns a single line", () => {
      expect(boundPreferenceText("Notes\napp", "fallback")).toBe("Notes app");
      expect(boundPreferenceText(`Ti${CONTROL}mer`, "fallback")).toBe("Ti mer");
    });

    it("clamps to the longest string a preference may hold", () => {
      const bounded = boundPreferenceText("x".repeat(MAX_PREFERENCE_STRING_LENGTH + 50), "fallback");
      expect(bounded).toHaveLength(MAX_PREFERENCE_STRING_LENGTH);
    });

    it("falls back for a non-string, and for anything it leaves empty", () => {
      expect(boundPreferenceText(42, "fallback")).toBe("fallback");
      expect(boundPreferenceText(undefined, "fallback")).toBe("fallback");
      expect(boundPreferenceText("   ", "fallback")).toBe("fallback");
      expect(boundPreferenceText(`${CONTROL}`, "fallback")).toBe("fallback");
    });

    it("leaves a name that is already fine alone", () => {
      expect(boundPreferenceText("Notes", "fallback")).toBe("Notes");
    });

    it("produces a value the write rules accept", () => {
      const bounded = boundPreferenceText(`Ti${CONTROL}mer\nApp`, "fallback");
      expect(validatePreference("ui_user_name", bounded).ok).toBe(true);
    });
  });
});
