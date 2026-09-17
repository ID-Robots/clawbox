import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import SetupWizard from "@/components/SetupWizard";
import { translations } from "@/lib/translations";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * Step 4 of the setup wizard, on a box that is not set to English.
 *
 * The card's heading was passed as a literal — `title="Connect AI Provider"` —
 * while every prop beside it went through the dictionary, so a Bulgarian owner
 * met one English heading on the one screen the wizard shows them once.
 * SettingsApp renders the SAME component with `tr("settings.aiConnectTitle",
 * …)`, and the key has existed in all ten locales the whole time; only the
 * wizard's call site never asked for it.
 *
 * Asserted through a locale rather than by matching the call: a test that spies
 * on `tr` passes just as well when the key is wrong, and the failure this
 * guards against is what the owner READS.
 *
 * `scripts/i18n-scan.ts` now fails the build on any literal of this shape
 * anywhere in src/components or src/app — that is the general guard, and it
 * would have caught this one. This file is the specific one: it pins that the
 * heading resolves to the Bulgarian sentence, which the scan cannot check
 * because a wrong-but-translated key is still a key.
 */

const LOCALE = "bg";
const table = translations[LOCALE];

vi.mock("@/lib/i18n", async () => {
  const { translations: real } = await import("@/lib/translations");
  const active = real.bg;
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    LANGUAGES: [
      { code: "en", flag: "🇬🇧", label: "English" },
      { code: "bg", flag: "🇧🇬", label: "Български" },
    ],
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          active[key] ?? key,
        ),
      locale: "bg",
      localeResolved: true,
      setLocale: vi.fn(),
    }),
  };
});

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

vi.mock("@/components/ProgressBar", () => ({
  default: ({ currentStep }: { currentStep: number }) => <div data-testid="progress-step">{currentStep}</div>,
}));

vi.mock("@/components/WifiStep", () => ({ default: () => <div /> }));
vi.mock("@/components/UpdateStep", () => ({ default: () => <div /> }));
vi.mock("@/components/CredentialsStep", () => ({ default: () => <div /> }));
vi.mock("@/components/TelegramStep", () => ({ default: () => <div /> }));

// The real card is a large tree with its own fetches; what this file is about
// is the ONE prop the wizard hands it, so the stub renders it as a heading —
// the same role a reader meets it in.
vi.mock("@/components/AIModelsStep", () => ({
  default: ({ title, description }: { title?: string; description?: string }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));

function atProviderStep(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      setup_complete: false,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: false,
      local_ai_configured: false,
      telegram_configured: false,
    }),
  } as Response;
}

describe("setup wizard, AI provider step, on a Bulgarian box", () => {
  beforeEach(() => {
    resetHarnessCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/setup-api/setup/status"
          ? atProviderStep()
          : ({ ok: true, status: 200, json: async () => ({}) } as Response),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  it("heads the card in Bulgarian, not in English", async () => {
    render(<SetupWizard />);

    const heading = await screen.findByRole("heading", { name: table["settings.aiConnectTitle"] });
    expect(heading).toBeInTheDocument();
    expect(screen.queryByText("Connect AI Provider")).toBeNull();
  });

  it("uses the same key Settings uses, so the two screens cannot drift apart", () => {
    // Not a spy on the call site — the fact that matters is that ONE sentence
    // is the answer for both surfaces, in every locale.
    for (const locale of Object.keys(translations)) {
      expect(translations[locale as keyof typeof translations]["settings.aiConnectTitle"]).toBeTruthy();
    }
    expect(table["settings.aiConnectTitle"]).not.toBe("Connect AI Provider");
  });

  it("still translates the description beside it", async () => {
    render(<SetupWizard />);
    expect(await screen.findByText(table["ai.description"])).toBeInTheDocument();
  });
});
