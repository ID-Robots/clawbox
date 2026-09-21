/**
 * The power menu's internet line (src/components/SystemTray.tsx).
 *
 * The UI sweep found it as the one line in that menu that ignored the
 * catalogue: "Internet · 15 ms" and "No internet" were literals beside a
 * translated Restart, Shut Down and Lock, so a German or Japanese desktop
 * showed English there (2026-09-07, shell-4). The menu is rendered with a `t`
 * that answers the KEY, so a literal shows up as English and a translated
 * string as its key — in both states — and the catalogue is checked for the
 * two keys in every locale, with the latency slot kept.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import SystemTray from "@/components/SystemTray";
import { translations } from "@/lib/translations";
import type { Locale } from "@/lib/i18n";

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}${JSON.stringify(params)}` : key,
  }),
}));

function stubInternet(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) }));
}

function renderTray() {
  return render(<SystemTray isOpen onClose={() => {}} date="Monday, September 7" time="09:18" />);
}

describe("SystemTray — the internet line", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the latency through the catalogue, with the number as a parameter", async () => {
    stubInternet({ online: true, latencyMs: 15 });
    renderTray();
    expect(await screen.findByText('tray.internet{"ms":15}')).toBeInTheDocument();
    expect(screen.queryByText(/Internet · /)).toBeNull();
  });

  it("says 'no internet' through the catalogue", async () => {
    stubInternet({ online: false });
    renderTray();
    expect(await screen.findByText("tray.noInternet")).toBeInTheDocument();
    expect(screen.queryByText("No internet")).toBeNull();
  });
});

describe("the internet line's catalogue", () => {
  const LOCALES: Locale[] = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];

  it.each(LOCALES)("'%s' carries both keys and keeps the latency slot", (locale) => {
    expect(translations[locale]["tray.internet"]).toContain("{ms}");
    expect(translations[locale]["tray.noInternet"]).toBeTruthy();
  });

  it("translates the line that has words in it", () => {
    // "Internet · {ms} ms" is legitimately the same in most Latin-script
    // locales; "No internet" is not.
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      expect(translations[locale]["tray.noInternet"], `'${locale}' still English`).not.toBe(translations.en["tray.noInternet"]);
    }
  });
});
