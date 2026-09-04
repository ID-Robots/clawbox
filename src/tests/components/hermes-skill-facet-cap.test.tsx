import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@/tests/helpers/test-utils";
import { useSkillCatalog } from "@/components/hermes-skills/useSkillCatalog";
import { MAX_FACET_SELECTION } from "@/lib/hermes-skills";

/**
 * TASK-658 item 1 — the owner could CLICK their way into a 400.
 *
 * The browse route accepts at most MAX_FACET_SELECTION (12) values per facet
 * group; the rail renders up to MAX_FACET_VALUES (24). `toggleFacet` had no cap
 * of its own, so ticking a 13th value in a group with more than twelve options
 * sent a request the route refused — and the refusal carried no code, so the
 * whole grid was replaced by "couldn't load the catalogue, retry", whose button
 * resends the same thirteen values.
 *
 * The server-side half (a `too_many_facets` code, told apart from an invalid
 * value) is in skills-refusal-codes.test.ts. This is the half that stops the
 * owner reaching it at all.
 */

const BROWSE_OK = {
  skills: [],
  page: 1,
  pageSize: 24,
  total: 0,
  totalPages: 0,
  hasMore: false,
  facets: { sources: [], providers: [], trust: [], categories: [] },
  categoryCoverage: 0,
  facetScope: "catalog",
  catalog: { origin: "index", skillCount: 1, fetchedAt: new Date().toISOString(), stale: false },
  degraded: false,
};

let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return { ok: true, json: async () => BROWSE_OK };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browse facet rail's own cap", () => {
  it("stops at the number the route accepts, instead of sending a 13th", async () => {
    const { result } = renderHook(() => useSkillCatalog(true));
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));

    for (let i = 0; i < MAX_FACET_SELECTION + 3; i++) {
      await act(async () => {
        result.current.toggleFacet("provider", `p${i}`);
      });
    }

    expect(result.current.selected.provider).toHaveLength(MAX_FACET_SELECTION);
    // ...and no request ever carried more than the route will take.
    for (const url of urls) {
      const providers = new URL(url, "http://localhost").searchParams.getAll("provider")
        .flatMap((raw) => raw.split(","))
        .filter(Boolean);
      expect(providers.length).toBeLessThanOrEqual(MAX_FACET_SELECTION);
    }
  });

  it("still unticks a value that is already on, once the cap is reached", async () => {
    const { result } = renderHook(() => useSkillCatalog(true));
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));

    for (let i = 0; i < MAX_FACET_SELECTION; i++) {
      await act(async () => {
        result.current.toggleFacet("provider", `p${i}`);
      });
    }
    await act(async () => {
      result.current.toggleFacet("provider", "p0");
    });

    expect(result.current.selected.provider).not.toContain("p0");
    expect(result.current.selected.provider).toHaveLength(MAX_FACET_SELECTION - 1);
  });
});
