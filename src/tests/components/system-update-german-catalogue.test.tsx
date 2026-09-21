import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";

/**
 * The other half of `system-update-i18n.test.tsx`.
 *
 * That file proves the component ASKS for its copy, against a catalogue the
 * test itself invents. This one proves the catalogue the device actually ships
 * ANSWERS: it feeds the page the real `translations.de` table, so a key nobody
 * ever added to a locale file — which renders as the English floor and looks
 * perfectly fine in a synthetic-catalogue test — fails here instead.
 */
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.de[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

import SystemUpdateApp from "@/components/SystemUpdateApp";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("SystemUpdateApp under the shipped German catalogue", () => {
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

  it("draws the hero, the component card and the buttons in German", async () => {
    const { findByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("1 Update verfügbar");
    await findByText("Neue Version verfügbar für ClawBox.");
    await findByText("Alles aktualisieren");
    await findByText("Geräte-Betriebssystem und integrierte Apps");
    await findByText("Installiert");
    await findByText("Neueste");

    // The words the page used to show a German owner.
    expect(queryByText("1 update available")).toBeNull();
    expect(queryByText("Update everything")).toBeNull();
    expect(queryByText("Device OS and built-in apps")).toBeNull();
  });

  it("draws Advanced options and its help text in German", async () => {
    const { findByText, findByRole, queryByText } = render(<SystemUpdateApp />);

    fireEvent.click(await findByRole("button", { name: /Erweiterte Optionen/ }));

    await findByText("Beta-Kanal");
    await findByText("Branch-Vorgabe");
    await findByText(/Bindet Updates an einen bestimmten Git-Branch/);
    expect(queryByText("Advanced options")).toBeNull();
    expect(queryByText(/Pin updates to a specific git branch/)).toBeNull();
  });
});
