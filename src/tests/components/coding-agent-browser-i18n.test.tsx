// The Coding Agent's browser switch and the wizard step that offers it are the
// newest copy on those two surfaces, and copy added in one pass is exactly what
// has shipped as English-on-every-box before (TASK-458). The parity test next
// door compares the tables to each other; this one renders through the provider
// the desktop actually mounts, so a key that reaches the screen as English —
// or as its raw name, which is what an unmerged table gives you — is caught on
// the surface the owner sees.
import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider, useT, type Locale } from "@/lib/i18n";
import { translations } from "@/lib/translations";

const KEYS = [
  "codingAgent.wizardBrowserTitle",
  "codingAgent.wizardBrowserSkip",
  "codingAgent.wizardIntro",
  "codingAgent.realBrowserLabel",
  "codingAgent.realBrowserHint",
] as const;

function CopyProbe() {
  const { t } = useT();
  return (
    <div>
      {KEYS.map((key) => (
        <span key={key} data-testid={key}>
          {t(key)}
        </span>
      ))}
    </div>
  );
}

/**
 * The locale reaches the provider through `pref:ui_language`, so the fetch has
 * to answer before any copy is looked up.
 */
function stubLanguage(locale: Locale) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(String(url).includes("preferences") ? { ui_language: locale } : {}),
      }),
    ),
  );
}

async function copyIn(locale: Locale): Promise<Record<string, string>> {
  stubLanguage(locale);
  render(
    <I18nProvider>
      <CopyProbe />
    </I18nProvider>,
  );
  // The provider starts at "en" and only reaches the saved locale once the
  // preference fetch answers, so waiting for "no longer the raw key" would
  // read the English pass and call it a translation.
  await waitFor(() =>
    expect(screen.getByTestId(KEYS[0]).textContent).toBe(translations[locale][KEYS[0]]),
  );
  return Object.fromEntries(
    KEYS.map((key) => [key, screen.getByTestId(key).textContent ?? ""]),
  );
}

describe("the coding agent's browser copy renders translated", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the German strings on a German box", async () => {
    const copy = await copyIn("de");
    expect(copy["codingAgent.realBrowserLabel"]).toBe("Im Browser dieser Box prüfen");
    expect(copy["codingAgent.wizardBrowserTitle"]).toBe("Läufe dürfen den Browser dieser Box nutzen");
    expect(copy["codingAgent.wizardBrowserSkip"]).toBe("Überspringen — unsichtbar browsen");
    // The step count is part of the wizard's promise: the browser step made it
    // four, and nine locale files still said three.
    expect(copy["codingAgent.wizardIntro"]).toContain("vier Schritte");
    // One register throughout the card — the block is Sie, and the two media
    // hints beside this switch had drifted to du.
    expect(copy["codingAgent.realBrowserHint"]).toContain("Sie");
    expect(copy["codingAgent.realBrowserHint"]).not.toMatch(/\bdu\b|\bdein/i);
  });

  it("shows Japanese, not the English underneath it", async () => {
    const copy = await copyIn("ja");
    expect(copy["codingAgent.realBrowserLabel"]).toBe("このボックスのブラウザーで確認する");
    expect(copy["codingAgent.wizardIntro"]).toContain("4 ステップ");
    for (const key of KEYS) {
      expect(copy[key], `${key} fell through to English`).not.toBe(translations.en[key]);
    }
  });
});
