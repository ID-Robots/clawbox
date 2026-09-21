// @vitest-environment jsdom
/**
 * The "Back to Desktop" link on every `/app/<id>` page.
 *
 * It was the last hard-coded English on that title bar: on a German box the
 * Files and Terminal pages said "Back to Desktop" beside a translated app
 * name. The literal sits inside `I18nProvider` — the page component itself is
 * ABOVE it, where `t()` echoes the key back — so it goes through a child, the
 * way the title already does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { render, screen } from "@/tests/helpers/test-utils";
import StandaloneAppPage from "@/app/app/[id]/page";

const catalogue = vi.hoisted(() => ({ table: {} as Record<string, string> }));

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => catalogue.table[key] ?? key }),
}));
// An id no app claims: the bar is what is under test, not what is under it.
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "nothing-here" }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/client-harness", () => ({ fetchHarness: vi.fn(async () => ({ active: "openclaw" })) }));

beforeEach(() => {
  catalogue.table = {};
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/app/<id> — the back link", () => {
  it("is translated when the catalogue carries the key", async () => {
    catalogue.table = { "app.backToDesktop": "Zurück zum Desktop" };
    render(<StandaloneAppPage />);
    const link = await screen.findByRole("link");
    expect(link).toHaveTextContent("Zurück zum Desktop");
    expect(link).toHaveAttribute("href", "/");
  });

  it("says the English, never the raw key, on a catalogue that lacks it", async () => {
    render(<StandaloneAppPage />);
    const link = await screen.findByRole("link");
    expect(link).toHaveTextContent("Back to Desktop");
  });
});
