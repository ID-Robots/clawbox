import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseResponse, CatalogFacet } from "@/lib/hermes-skills";
import { buildCatalogState } from "@/lib/hermes-skill-index";

/**
 * The browse endpoint's half of the facet rail.
 *
 * Two properties matter more than the filtering itself:
 *
 *  - a facet value the rail sends must be VALIDATED, not trusted. Nothing here
 *    reaches the CLI (the catalogue filter is in memory), but a route that
 *    accepts anything is one refactor away from one that does.
 *  - a count must say what it measured. With the offline index the counts are
 *    over the whole matching catalogue; without it they can only be over the
 *    rows the CLI returned, and TASK-452 is a list of surfaces that stated a
 *    number confidently and wrongly. So the response labels its own scope.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-skill-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skill-index")>();
  return {
    ...actual,
    loadCatalog: vi.fn(),
    warmIndex: vi.fn(),
    isWarming: vi.fn(() => false),
    cliSearch: vi.fn(),
    cliBrowse: vi.fn(),
  };
});

import { cliBrowse, cliSearch, loadCatalog } from "@/lib/hermes-skill-index";

const mockLoadCatalog = vi.mocked(loadCatalog);
const mockCliBrowse = vi.mocked(cliBrowse);
const mockCliSearch = vi.mocked(cliSearch);

/** A catalogue shaped like the box's: mostly clawhub, mostly uncategorised. */
const CATALOGUE = buildCatalogState({
  version: 1,
  generated_at: "2026-08-01T00:00:00Z",
  skills: [
    { name: "one", identifier: "official/one", source: "official", trust_level: "builtin", tags: [], extra: { category: "Developer Tools" } },
    { name: "two", identifier: "NVIDIA/two", source: "github", trust_level: "trusted", tags: [], extra: { provider: "NVIDIA", category: "developer-tools" } },
    { name: "three", identifier: "clawhub/three", source: "clawhub", trust_level: "community", tags: [], extra: {} },
    { name: "four", identifier: "clawhub/four", source: "clawhub", trust_level: "community", tags: [], extra: { category: "finance" } },
    { name: "five", identifier: "skills-sh/five", source: "skills.sh", trust_level: "community", tags: [], extra: {} },
  ],
});

// The route's own contract, so a change to it fails here rather than sliding
// past a hand-written copy that agrees with the assertions by construction.
type Body = Pick<
  BrowseResponse,
  "skills" | "total" | "facets" | "categoryCoverage" | "facetScope" | "degraded"
>;

async function browse(query: string) {
  const { GET } = await import("@/app/setup-api/hermes/skills/browse/route");
  const res = await GET(new Request(`http://localhost/setup-api/hermes/skills/browse?${query}`));
  return { status: res.status, body: (await res.json()) as Body };
}

const countOf = (list: CatalogFacet[], id: string) => list.find((f) => f.id === id)?.count;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadCatalog.mockResolvedValue(CATALOGUE);
});

describe("browse facets over the offline index", () => {
  it("answers with every group the rail draws", async () => {
    const { body } = await browse("page=1&size=24");
    expect(countOf(body.facets.trust, "official")).toBe(1);
    expect(countOf(body.facets.trust, "community")).toBe(3);
    expect(countOf(body.facets.sources, "clawhub")).toBe(2);
    expect(countOf(body.facets.categories, "developer-tools")).toBe(2);
    expect(body.facetScope).toBe("catalog");
  });

  it("says how many of the matching rows carry a category at all", async () => {
    const { body } = await browse("page=1&size=24");
    expect(body.total).toBe(5);
    expect(body.categoryCoverage).toBe(3);
  });

  it("takes a repeated parameter per ticked value", async () => {
    const { body } = await browse("source=official&source=clawhub");
    expect(body.total).toBe(3);
  });

  it("takes a comma list, so a pasted URL still works", async () => {
    const { body } = await browse("source=official,clawhub");
    expect(body.total).toBe(3);
  });

  it("ANDs across groups", async () => {
    const { body } = await browse("source=clawhub&category=finance");
    expect(body.total).toBe(1);
    expect(body.skills[0].id).toBe("clawhub/four");
  });

  it("keeps the single-source form the MCP tool sends", async () => {
    const { body } = await browse("source=github");
    expect(body.total).toBe(1);
  });

  it("offers the publisher group exactly while GitHub rows are reachable", async () => {
    // No source filter at all: GitHub rows are in the answer, so its publishers
    // are a filter the customer can actually use.
    expect(countOf((await browse("page=1")).body.facets.providers, "NVIDIA")).toBe(1);
    expect(countOf((await browse("source=github")).body.facets.providers, "NVIDIA")).toBe(1);
    // A source filter that excludes GitHub takes the group away with it.
    expect((await browse("source=clawhub")).body.facets.providers).toEqual([]);
  });

  it("filters on trust, which is the one facet every row has", async () => {
    const { body } = await browse("trust=official,trusted");
    expect(body.total).toBe(2);
  });

  it("rejects a facet value it does not recognise instead of ignoring it", async () => {
    expect((await browse("trust=gold")).status).toBe(400);
    expect((await browse("category=Developer%20Tools")).status).toBe(400); // label, not key
    expect((await browse("category=..%2Fetc")).status).toBe(400);
    expect((await browse("source=not-a-registry")).status).toBe(400);
  });

  it("refuses an unbounded selection rather than looping over it", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `category=c${i}`).join("&");
    expect((await browse(many)).status).toBe(400);
  });

  it("de-duplicates a repeated value", async () => {
    const { body } = await browse("source=clawhub&source=clawhub&source=clawhub");
    expect(body.total).toBe(2);
  });
});

describe("browse facets with no index (the CLI fallback)", () => {
  beforeEach(() => {
    mockLoadCatalog.mockResolvedValue(null);
    mockCliBrowse.mockResolvedValue({
      skills: [
        { id: "clawhub/a", name: "a", source: "clawhub", trust: "community" },
        { id: "official/b", name: "b", source: "official", trust: "builtin" },
        { id: "NVIDIA/c", name: "c", source: "github", trust: "trusted", provider: "NVIDIA" },
        // A registry this build has never heard of, and a publisher string the
        // route's own validator rejects.
        { id: "newreg/d", name: "d", source: "brand-new-registry", trust: "community" },
        { id: "github/e", name: "e", source: "github", trust: "community", provider: "we/ird" },
      ],
    } as unknown as Awaited<ReturnType<typeof cliBrowse>>);
    mockCliSearch.mockResolvedValue([
      { id: "clawhub/a", name: "a", source: "clawhub", trust: "community" },
    ]);
  });

  it("says its counts are over the loaded rows, not the catalogue", async () => {
    const { body } = await browse("page=1&size=24");
    expect(body.degraded).toBe(true);
    expect(body.facetScope).toBe("loaded");
    expect(countOf(body.facets.trust, "community")).toBe(3);
  });

  it("still applies a rail selection the CLI flag cannot express", async () => {
    // `--source` takes one value; trust has no flag at all. Filtering the
    // returned rows is what stops a ticked box from looking ignored.
    const { body } = await browse("trust=official");
    expect(body.skills.map((s) => s.id)).toEqual(["official/b"]);
    expect(body.total).toBe(1);
  });

  it("sends the CLI a --source flag only for a single recognised source", async () => {
    await browse("source=github");
    expect(mockCliBrowse.mock.calls[0][2]).toBe("github");
    mockCliBrowse.mockClear();
    await browse("source=github&source=clawhub");
    expect(mockCliBrowse.mock.calls[0][2]).toBeUndefined();
  });

  it("counts a group WITHOUT its own filter here too", async () => {
    // The rail cannot tell which path answered it, so the counting rule has to
    // be the same: ticking Official must not make the other trust buckets read
    // zero over rows that plainly contain them.
    const { body } = await browse("trust=official");
    expect(body.skills.map((s) => s.id)).toEqual(["official/b"]);
    expect(countOf(body.facets.trust, "community")).toBe(3);
    expect(countOf(body.facets.trust, "trusted")).toBe(1);
    // …while the other groups do narrow to what Official can reach.
    expect(countOf(body.facets.sources, "clawhub")).toBeUndefined();
  });

  it("applies a publisher selection too, and drops the rows that cannot answer", async () => {
    // The CLI's own rows carry no `provider`, so keeping them would let a
    // publisher filter answer with the whole registry.
    const { body } = await browse("source=github&provider=nvidia");
    expect(body.skills.map((s) => s.id)).toEqual(["NVIDIA/c"]);
    expect(body.total).toBe(1);
    expect((await browse("source=clawhub&provider=nvidia")).body.total).toBe(0);
  });

  it("never offers a facet value it would then reject, but still lists the row", async () => {
    const { body } = await browse("page=1&size=24");
    expect(body.facets.sources.some((f) => f.id === "brand-new-registry")).toBe(false);
    expect(body.facets.providers.some((f) => f.id === "we/ird")).toBe(false);
    // The skills themselves are real answers and stay in the grid.
    expect(body.skills.map((s) => s.id)).toContain("newreg/d");
    expect(body.skills.map((s) => s.id)).toContain("github/e");
  });

  it("passes a query through to search and still filters it", async () => {
    const { body } = await browse("q=a&trust=official");
    expect(mockCliSearch).toHaveBeenCalled();
    expect(body.skills).toEqual([]);
  });
});
