import { describe, expect, it, vi } from "vitest";
import { buildCatalogState } from "@/lib/hermes-skill-index";

/**
 * TASK-452 / ux-page-1000-cap — Browse could not reach most of the catalogue.
 *
 * Measured on the box: `page=1000` answered 200 with `totalPages: 3760` and
 * `hasMore: true`, and `page=1001` answered 400 "Invalid page". So the
 * infinite-scroll sentinel was told to keep going and its next request was
 * rejected — at the UI's page size, 24 000 of 90 219 rows reachable (73.4 %
 * hidden), and the last scroll of every deep browse an error state.
 *
 * The cap was never about performance: the catalogue is an in-memory array
 * sorted once at load, so a deep offset is a slice. These tests pin BOTH halves
 * of the fix — the reachable window, and the fact that the response never
 * promises a page it would then reject.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-skill-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skill-index")>();
  return { ...actual, loadCatalog: vi.fn(), warmIndex: vi.fn(), isWarming: vi.fn(() => false) };
});

import { loadCatalog } from "@/lib/hermes-skill-index";

const mockLoadCatalog = vi.mocked(loadCatalog);

/** A catalogue with `n` installable rows, shaped like the real index. */
function catalogue(n: number) {
  return buildCatalogState({
    version: 1,
    generated_at: "2026-08-01T00:00:00Z",
    skills: Array.from({ length: n }, (_, i) => ({
      name: `skill-${String(i).padStart(6, "0")}`,
      description: `skill ${i}`,
      source: "clawhub",
      identifier: `clawhub/skill-${String(i).padStart(6, "0")}`,
      trust_level: "community",
      tags: [],
      extra: {},
    })),
  });
}

async function browse(query: string) {
  const { GET } = await import("@/app/setup-api/hermes/skills/browse/route");
  const res = await GET(new Request(`http://localhost/setup-api/hermes/skills/browse?${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe("browse paging (TASK-452)", () => {
  it("serves page 1001 — the first page the old cap rejected", async () => {
    // 1001 * 24 = 24 024 rows in, well inside a real 90 000-row catalogue.
    mockLoadCatalog.mockResolvedValue(catalogue(30_000));
    const { status, body } = await browse("page=1001&size=24");
    expect(status).toBe(200);
    expect(body.page).toBe(1001);
    expect(body.skills).toHaveLength(24);
    // And it is genuinely deep in the list, not page 1 under another number.
    expect((body.skills as unknown as { id: string }[])[0].id).toBe("clawhub/skill-024000");
  });

  it("never advertises a page it would then reject", async () => {
    mockLoadCatalog.mockResolvedValue(catalogue(30_000));
    const { body } = await browse("page=1&size=24");
    const totalPages = body.totalPages as unknown as number;
    // The sentinel's contract: whatever totalPages says must be fetchable.
    const last = await browse(`page=${totalPages}&size=24`);
    expect(last.status).toBe(200);
    expect(last.body.hasMore).toBe(false);
  });

  it("reports hasMore truthfully at the boundary", async () => {
    mockLoadCatalog.mockResolvedValue(catalogue(50));
    expect((await browse("page=2&size=24")).body.hasMore).toBe(true);
    const last = await browse("page=3&size=24");
    expect(last.body.hasMore).toBe(false);
    expect(last.body.skills).toHaveLength(2);
  });

  it("still rejects a nonsense page rather than accepting anything", async () => {
    mockLoadCatalog.mockResolvedValue(catalogue(10));
    expect((await browse("page=0&size=24")).status).toBe(400);
    expect((await browse("page=-1&size=24")).status).toBe(400);
    expect((await browse("page=1.5&size=24")).status).toBe(400);
    expect((await browse("page=999999999&size=24")).status).toBe(400);
  });
});
