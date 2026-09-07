import { afterEach, describe, expect, it, vi } from "vitest";
import { translations } from "@/lib/translations";
import { formatNextRun } from "@/components/clawkeep-ui";

/**
 * Two German strings the locale sweep of 2026-09-07 read on screen.
 *
 * DE-5: the Settings rail is 155 px of label. "Systemaktualisierung" has no
 * break opportunity, so the rail — which wraps rather than truncates, by
 * design — split it as "Systemaktualisierun / g". The launcher's own label for
 * the same app carries a soft hyphen and wraps cleanly; the rail's must offer
 * a break of its own — and it is the launcher's form, not a second name, so
 * the rail, the launcher tile and the window it opens (`update.title`) call
 * one app one thing.
 *
 * DE-9: "Nächste Ausführung in 16Std 32Min" — the English "16h 32m" shape
 * carried over into German, which writes the unit apart from the number.
 */

const de = translations.de;

afterEach(() => vi.useRealTimers());

describe("German catalogue shapes", () => {
  it("gives the System Update rail label a place to break", () => {
    expect(de["settings.systemUpdate"]).toMatch(/[-\u00AD]/);
  });

  it("names the System Update app alike on the rail, the launcher tile and the window", () => {
    const plain = (s: string) => s.replace(/\u00AD/g, "");
    expect(plain(de["settings.systemUpdate"])).toBe(de["update.title"]);
    expect(plain(de["app.systemUpdate"])).toBe(de["update.title"]);
  });

  it("puts a space between the number and its unit in the next-run strings", () => {
    for (const key of ["clawkeep.inDays", "clawkeep.inHours", "clawkeep.inMinutes"]) {
      // Every placeholder is followed by a space, never straight by the unit.
      expect(de[key], key).not.toMatch(/\}\S/);
    }
  });

  it("renders 'in 16 Std. 32 Min.' for a run sixteen and a half hours out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T09:00:00Z"));
    const t = (key: string, params?: Record<string, string | number>) => {
      let str = de[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    };
    const when = Date.now() + (16 * 60 + 32) * 60_000;
    expect(formatNextRun(when, t)).toBe("in 16 Std. 32 Min.");
  });
});
