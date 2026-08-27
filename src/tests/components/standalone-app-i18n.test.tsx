import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import type React from "react";
import StandaloneAppPage from "@/app/app/[id]/page";

/**
 * `/app/<id>` — the route behind "Open in new tab" — rendered every app it
 * hosts OUTSIDE an `I18nProvider`. `useT()` falls back to returning the key, so
 * that page painted `skills.facetTrust` and `settings.security.…` at the
 * customer while the desktop, which does wrap, showed sentences. Nobody caught
 * it because the store's copy used to reach the screen through `<option>`
 * labels and `sr-only` text; the facet rail puts a translated legend above
 * every group.
 */

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "hermes-skills" }) }));
// The page's chrome is not what is under test, and next/link's prefetch
// observer does not survive jsdom's IntersectionObserver stub.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/client-harness", () => ({ fetchHarness: vi.fn(async () => ({ active: "hermes" })) }));

const BROWSE = {
  skills: [],
  page: 1,
  pageSize: 24,
  total: 0,
  totalPages: 1,
  hasMore: false,
  facets: {
    sources: [],
    providers: [],
    trust: [{ id: "official", label: "official", count: 3 }],
    categories: [],
  },
  categoryCoverage: 0,
  facetScope: "catalog",
  catalog: { origin: "index", skillCount: 3 },
  degraded: false,
};

const INSTALLED = {
  skills: [{ id: "pdf", name: "PDF", category: "documents", source: "builtin", trust: "builtin", origin: "builtin" }],
  counts: { total: 1 },
  categories: [],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/preferences")) return { ok: true, json: async () => ({ ui_language: "en" }) };
      if (url.includes("/skills/browse")) return { ok: true, json: async () => BROWSE };
      if (url.includes("/skills/installed")) return { ok: true, json: async () => INSTALLED };
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/app/<id> resolves its copy", () => {
  it("renders sentences, not translation keys", async () => {
    render(<StandaloneAppPage />);
    // The app is a `dynamic(..., { ssr: false })` import and the provider loads
    // its catalogue with a second one, so both have to land first.
    await screen.findByTestId("hermes-skills-store", {}, { timeout: 5000 });
    await screen.findByText("Browse", {}, { timeout: 5000 });
    // The one property that matters: nothing on the page reads as a raw key.
    await waitFor(() =>
      expect(document.body.textContent).not.toMatch(/\bskills\.[a-zA-Z]/),
    );
    // And a positive check, so the assertion above cannot pass on an empty page.
    expect(screen.getByTestId("skill-tab-browse").textContent).toBe("Browse");
    expect(screen.getAllByText("Filters").length).toBeGreaterThan(0);
  });
});
