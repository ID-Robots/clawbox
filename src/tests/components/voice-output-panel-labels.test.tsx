import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import VoiceOutputPanel from "@/components/VoiceOutputPanel";

/**
 * The Voice dropdown draws each entry from the catalogue: on a German desktop
 * it read "Ash — male, warm" between German labels (locale sweep DE-8,
 * 2026-09-07).
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string) => translations.de[key] ?? translations.en[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function engine(over: Record<string, unknown> = {}) {
  return { id: "local", providerId: "tts-local-cli", label: "On this box", configured: true, detail: "Speaks on the box itself.", ...over };
}

const status = {
  choice: "auto",
  activeProviderId: "openai",
  activeEngine: "cloud",
  preferredEngine: "cloud",
  drifted: false,
  engines: [engine(), engine({ id: "cloud", providerId: "openai", label: "ClawBox cloud", configured: true, detail: "Speaks in the cloud." })],
  warning: "",
  disclosure: { kind: "uses-cloud", providers: ["ClawBox AI"], primaryIsLocal: false },
  language: "de",
  voice: { local: "af_heart", cloud: "alloy" },
};

afterEach(() => vi.unstubAllGlobals());

describe("Voice panel voice list", () => {
  it("names each voice in the owner's language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } }),
    ));
    render(<VoiceOutputPanel active />);

    const select = await screen.findByTestId("voice-voice");
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toContain(translations.de["settings.voice.name.ash"]);
    expect(labels).not.toContain("Ash — male, warm");
  });
});
