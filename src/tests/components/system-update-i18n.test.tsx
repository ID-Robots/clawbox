import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render } from "@/tests/helpers/test-utils";

/**
 * The System Update page was one `t()` call and forty English literals: a
 * German desktop opened a window titled "Systemaktualisierung" whose every word
 * — "1 update available", "Update everything", "Device OS and built-in apps",
 * "INSTALLED / LATEST", "Advanced options" — was English.
 *
 * The catalogue here is what a locale file will carry once the strings are
 * keyed; the point of the test is that the component ASKS for them. The last
 * case pins the other half: a key the catalogue does not have yet renders the
 * English that used to be hard-coded, never the raw `update.*` key.
 */
const CATALOGUE: Record<string, string> = {
  "update.heroAvailableOne": "1 Update verfügbar",
  "update.heroAvailableSub": "Neue Version verfügbar für {components}.",
  "update.updateEverything": "Alles aktualisieren",
  "update.clawboxCardSub": "Geräte-OS und integrierte Apps",
  "update.installed": "Installiert",
  "update.latest": "Neueste",
  "update.badgeUpdate": "UPDATE",
  "update.advancedOptions": "Erweiterte Optionen",
  "update.betaChannel": "Beta-Kanal",
  "update.branchOverride": "Branch überschreiben",
};

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      let str = CATALOGUE[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

import SystemUpdateApp from "@/components/SystemUpdateApp";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("SystemUpdateApp — speaks the UI language", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "4.0.0", target: "4.1.0", updateAvailable: true },
            openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false },
            edition: "openclaw",
            remote: { reachable: true },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
        return jsonResponse({});
      }),
    );
  });

  it("renders the hero and the component card from the catalogue", async () => {
    const { findByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("1 Update verfügbar");
    await findByText("Neue Version verfügbar für ClawBox.");
    await findByText("Alles aktualisieren");
    await findByText("Geräte-OS und integrierte Apps");
    await findByText("Installiert");
    await findByText("Neueste");
    expect(queryByText("1 update available")).toBeNull();
    expect(queryByText("Update everything")).toBeNull();
  });

  it("renders Advanced options and its controls from the catalogue", async () => {
    const { findByText, getByRole, findByRole } = render(<SystemUpdateApp />);

    fireEvent.click(await findByRole("button", { name: /Erweiterte Optionen/ }));

    await findByText("Beta-Kanal");
    await findByText("Branch überschreiben");
    // The switch had no accessible name at all — a bare styled <button> whose
    // only text was the sliding knob.
    expect(getByRole("switch", { name: "Beta-Kanal" })).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to the English it used to hard-code for a key the catalogue lacks", async () => {
    const { findByText, queryByText } = render(<SystemUpdateApp />);

    // `update.agent` is deliberately absent from CATALOGUE above.
    await findByText("Agent");
    expect(queryByText("update.agent")).toBeNull();
  });
});
