// <html lang> must name the language the UI is actually rendering.
//
// The root layout is a server component and hardcodes lang="en"; the locale is
// picked on the client (pref:ui_language, else navigator.language). Before this
// fix a Bulgarian, Japanese or German UI still advertised lang="en", so a
// screen reader read the whole page with an English voice — every locale but
// `en` was affected, on every route including /login and the captive portal.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider, useSyncHtmlLang, useT, type Locale } from "@/lib/i18n";

function LocaleProbe() {
  const { locale, setLocale } = useT();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale("de" as Locale)}>to-de</button>
    </div>
  );
}

function stubPreference(value: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      if (String(url).includes("preferences")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ui_language: value }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

describe("<html lang> tracks the active locale", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("lang", "en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.setAttribute("lang", "en");
  });

  it("is the server-rendered 'en' before the preference resolves", () => {
    // Guards the no-hydration-mismatch property: the provider must not change
    // the attribute during render, only after an effect.
    expect(document.documentElement.lang).toBe("en");
  });

  it("switches to the saved preference", async () => {
    stubPreference("bg");
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("bg"));
    expect(screen.getByTestId("locale").textContent).toBe("bg");
  });

  it("falls back to the detected browser language when nothing is saved", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("ja-JP");
    stubPreference(undefined);
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("ja"));
  });

  it("stays 'en' for an unsupported browser language", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-BR");
    stubPreference(undefined);
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    // Wait for the preference round-trip to have been decided, not just for a
    // value that happened to already be "en".
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("locale").textContent).toBe("en"));
    expect(document.documentElement.lang).toBe("en");
  });

  it("only the outermost provider writes the attribute", () => {
    // The gate itself, isolated from provider mount order.
    function Probe({ root }: { root: boolean }) {
      useSyncHtmlLang("de", root);
      return null;
    }
    render(<Probe root={false} />);
    expect(document.documentElement.lang).toBe("en");
    render(<Probe root />);
    expect(document.documentElement.lang).toBe("de");
  });

  it("follows a language change made in Settings", async () => {
    stubPreference("bg");
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("bg"));

    await act(async () => {
      screen.getByText("to-de").click();
    });
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
  });

  it("is not reset by a nested provider that has not resolved its own locale", async () => {
    // SettingsApp mounts an inner I18nProvider around the embedded
    // AIModelsStep. Every provider starts at "en" and only learns the real
    // locale after its own fetch, so an ungated inner provider would flip a
    // Bulgarian device back to lang="en" the moment Settings opened.
    stubPreference("bg");
    const { rerender } = render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("bg"));

    await act(async () => {
      rerender(
        <I18nProvider>
          <LocaleProbe />
          <I18nProvider>
            <span>settings-panel</span>
          </I18nProvider>
        </I18nProvider>,
      );
    });
    // The inner provider has mounted and run its effects at its initial "en".
    expect(document.documentElement.lang).toBe("bg");
  });

  it("leaves the attribute alone when the preference fetch fails", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("sv-SE");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    // Detection still applies — an offline box must not lose its locale.
    await waitFor(() => expect(document.documentElement.lang).toBe("sv"));
  });
});
