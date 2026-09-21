import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import type React from "react";
import StandaloneAppPage from "@/app/app/[id]/page";

/**
 * The customer-visible half of the same defect the unit test holds from the
 * data side: `/app/hermes-skills` — the window behind "Open in new tab" — is
 * titled from the desktop registry, so on a Bulgarian box its title bar says
 * "Умения", not "Hermes Skills". It used to carry its own English name table,
 * so this was the one part of the window that never translated.
 */
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "hermes-skills" }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/client-harness", () => ({ fetchHarness: vi.fn(async () => ({ active: "hermes" })) }));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/preferences")) return { ok: true, json: async () => ({ ui_language: "bg" }) };
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/app/<id> title bar", () => {
  it("names the app in the owner's language", async () => {
    render(<StandaloneAppPage />);
    // The locale arrives from a fetch and the catalogue from a dynamic import,
    // so the first paint is still English — wait for the translated title.
    expect(await screen.findByText("Умения", {}, { timeout: 10000 })).toBeTruthy();
    expect(screen.queryByText("Hermes Skills")).toBeNull();
  }, 15000);
});
