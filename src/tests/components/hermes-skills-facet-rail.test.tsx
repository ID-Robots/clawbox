import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import userEvent from "@testing-library/user-event";
import { buildCatalogState, queryCatalog } from "@/lib/hermes-skill-index";
import type { SortOption } from "@/lib/hermes-skills";
import HermesSkillsStore from "@/components/HermesSkillsStore";

/**
 * Design A, "Faceted Rail" — the store's filters.
 *
 * Before this, Browse had NO category filter and no way to narrow by trust or
 * by what the installer's scanner said, and Installed had one category
 * <select>. The two attributes that decide whether a customer should install
 * something were the two they could not filter on.
 *
 * The browse endpoint is faked here by the REAL catalogue query, so "ticking a
 * box filters the grid" and "the number beside a box is right" are tested
 * against the code that will answer on the device — not against a hand-written
 * response that agrees with the assertions by construction.
 */

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { skillsEn } = await import("@/lib/hermes-translations/en-skills");
  return {
    ...actual,
    useT: () => ({
      locale: "en" as const,
      localeResolved: true,
      setLocale: () => {},
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          skillsEn[key] ?? key,
        ),
    }),
  };
});

const CATALOGUE = buildCatalogState({
  version: 1,
  generated_at: "2026-08-01T00:00:00Z",
  skills: [
    { name: "Official Alpha", identifier: "official/alpha", source: "official", trust_level: "builtin", tags: [], extra: { category: "Developer Tools" } },
    { name: "Trusted Bravo", identifier: "NVIDIA/bravo", source: "github", trust_level: "trusted", tags: [], extra: { provider: "NVIDIA", category: "developer-tools" } },
    { name: "Community Charlie", identifier: "clawhub/charlie", source: "clawhub", trust_level: "community", tags: [], extra: {} },
    { name: "Community Delta", identifier: "clawhub/delta", source: "clawhub", trust_level: "community", tags: [], extra: { category: "finance" } },
    { name: "Community Echo", identifier: "skills-sh/echo", source: "skills.sh", trust_level: "community", tags: [], extra: {} },
  ],
});

const INSTALLED = {
  skills: [
    { id: "pdf", name: "PDF", category: "documents", source: "builtin", trust: "builtin", origin: "builtin" },
    { id: "notes", name: "Notes", category: "documents", source: "clawhub", trust: "community", origin: "hub", identifier: "clawhub/notes", scanVerdict: "safe" },
    { id: "shell-helper", name: "Shell Helper", category: "devops", source: "clawhub", trust: "community", origin: "hub", identifier: "clawhub/shell-helper", scanVerdict: "dangerous" },
    { id: "scratch", name: "Scratch", category: "other", source: "local", origin: "local" },
  ],
  counts: { total: 4, builtin: 1, hub: 2, local: 1, incompatible: 0 },
  categories: [
    { id: "documents", count: 2 },
    { id: "devops", count: 1 },
    { id: "other", count: 1 },
  ],
};

/** Repeats + comma lists, exactly as the route reads them. */
function multi(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((raw) => raw.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Answers /skills/browse from the real catalogue query. */
function browseBody(url: string, degraded = false) {
  const params = new URL(url, "http://localhost").searchParams;
  const result = queryCatalog(CATALOGUE, {
    q: params.get("q") || undefined,
    sources: multi(params, "source"),
    providers: multi(params, "provider"),
    trust: multi(params, "trust"),
    categories: multi(params, "category"),
    sort: (params.get("sort") || "trust") as SortOption,
    page: Number(params.get("page") || 1),
    pageSize: Number(params.get("size") || 24),
  });
  return {
    skills: result.skills,
    page: 1,
    pageSize: 24,
    total: result.total,
    totalPages: 1,
    hasMore: false,
    facets: {
      sources: result.sources,
      providers: multi(params, "source").includes("github") ? result.providers : [],
      trust: result.trust,
      categories: result.categories,
    },
    categoryCoverage: result.categoryCoverage,
    facetScope: degraded ? "loaded" : "catalog",
    catalog: { origin: degraded ? "cli" : "index", skillCount: 5, fetchedAt: new Date().toISOString(), stale: false },
    degraded,
  };
}

function mockServer({ degraded = false }: { degraded?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/skills/browse")) {
      return { ok: true, json: async () => browseBody(url, degraded) };
    }
    return { ok: true, json: async () => INSTALLED };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openStore(tab: "browse" | "installed") {
  render(<HermesSkillsStore />);
  const button = await screen.findByTestId(`skill-tab-${tab}`);
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(screen.getAllByRole("group").length).toBeGreaterThan(0));
}

/** The rail is rendered twice — the column and the drawer's copy. Take the first. */
function facetBox(group: string, id: string): HTMLInputElement {
  return screen.getAllByTestId(`hs-facet-${group}-${id}`)[0] as HTMLInputElement;
}

async function tick(group: string, id: string) {
  await act(async () => {
    fireEvent.click(facetBox(group, id));
  });
}

beforeEach(() => {
  mockServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Browse: the facet rail filters the grid", () => {
  it("shows every group the catalogue supports, with a count beside each value", async () => {
    await openStore("browse");
    expect(facetBox("trust", "official")).toBeTruthy();
    expect(facetBox("trust", "community")).toBeTruthy();
    expect(facetBox("source", "clawhub")).toBeTruthy();
    expect(facetBox("category", "developer-tools")).toBeTruthy();

    // The count beside a value is what ticking it would reach.
    const label = facetBox("trust", "community").closest("label") as HTMLElement;
    expect(within(label).getByText("3")).toBeTruthy();
    const devTools = facetBox("category", "developer-tools").closest("label") as HTMLElement;
    // Both spellings of the category counted as one bucket.
    expect(within(devTools).getByText("2")).toBeTruthy();
  });

  it("ticking a value narrows the grid", async () => {
    await openStore("browse");
    await waitFor(() => expect(screen.getByText("Community Charlie")).toBeTruthy());

    await tick("trust", "official");

    await waitFor(() => expect(screen.queryByText("Community Charlie")).toBeNull());
    expect(screen.getByText("Official Alpha")).toBeTruthy();
  });

  it("multi-select inside a group widens; across groups it narrows", async () => {
    await openStore("browse");

    await tick("trust", "official");
    await waitFor(() => expect(screen.queryByText("Trusted Bravo")).toBeNull());

    await tick("trust", "trusted");
    await waitFor(() => expect(screen.getByText("Trusted Bravo")).toBeTruthy());
    expect(screen.getByText("Official Alpha")).toBeTruthy();

    // A second group is an AND: only the official one is from `official`.
    await tick("source", "official");
    await waitFor(() => expect(screen.queryByText("Trusted Bravo")).toBeNull());
    expect(screen.getByText("Official Alpha")).toBeTruthy();
  });

  it("counts a group without its own filter, so its siblings never read zero", async () => {
    await openStore("browse");
    await tick("trust", "community");

    await waitFor(() => {
      const official = facetBox("trust", "official").closest("label") as HTMLElement;
      expect(within(official).getByText("1")).toBeTruthy();
    });
  });
});

describe("Browse: the active filters above the grid", () => {
  it("puts a chip up for every ticked value", async () => {
    await openStore("browse");
    await tick("trust", "community");
    await waitFor(() => expect(facetBox("source", "clawhub")).toBeTruthy());
    await tick("source", "clawhub");

    await waitFor(() => expect(screen.getByTestId("hs-chip-trust-community")).toBeTruthy());
    expect(screen.getByTestId("hs-chip-source-clawhub")).toBeTruthy();
  });

  it("a chip removes its OWN filter and leaves the rest applied", async () => {
    await openStore("browse");
    await tick("trust", "official");
    await tick("trust", "trusted");
    await waitFor(() => expect(screen.getByTestId("hs-chip-trust-trusted")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("hs-chip-trust-trusted"));
    });

    await waitFor(() => expect(screen.queryByTestId("hs-chip-trust-trusted")).toBeNull());
    expect(screen.getByTestId("hs-chip-trust-official")).toBeTruthy();
    expect(facetBox("trust", "official").checked).toBe(true);
    expect(facetBox("trust", "trusted").checked).toBe(false);
  });

  it("names what it removes, for a reader who cannot see the chip", async () => {
    await openStore("browse");
    await tick("trust", "official");
    await waitFor(() =>
      expect(screen.getByLabelText("Remove filter Trust: Official")).toBeTruthy(),
    );
  });

  it("clear all resets every group at once", async () => {
    await openStore("browse");
    await tick("trust", "official");
    await tick("source", "official");
    await waitFor(() => expect(screen.getByTestId("hs-clear-all")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("hs-clear-all"));
    });

    await waitFor(() => expect(screen.queryByTestId("hs-active-filters")).toBeNull());
    expect(facetBox("trust", "official").checked).toBe(false);
    expect(facetBox("source", "official").checked).toBe(false);
    expect(screen.getByText("Community Charlie")).toBeTruthy();
  });
});

describe("Browse: the rail is honest about what it can count", () => {
  it("says how many of the results declare a category at all", async () => {
    await openStore("browse");
    // 3 of the 5 catalogue rows carry one — the rail does not let the buckets
    // imply they add up to the result count.
    await waitFor(() => expect(screen.getAllByText("3 of 5 say what they are.").length).toBeGreaterThan(0));
  });

  it("says when a count could only be measured over the loaded rows", async () => {
    vi.unstubAllGlobals();
    mockServer({ degraded: true });
    await openStore("browse");
    await waitFor(() =>
      expect(screen.getAllByText(/Counts cover the .* skills loaded/).length).toBeGreaterThan(0),
    );
  });

  it("explains why Safety is not a filter here", async () => {
    await openStore("browse");
    expect(screen.getAllByText(/Safety is checked while a skill installs/).length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("hs-facet-safety-safe")).toHaveLength(0);
  });
});

describe("Installed: the same rail, over the list on disk", () => {
  it("offers Safety, which only the installed side can answer", async () => {
    await openStore("installed");
    expect(facetBox("safety", "safe")).toBeTruthy();
    expect(facetBox("safety", "dangerous")).toBeTruthy();
    expect(facetBox("safety", "unscanned")).toBeTruthy();
  });

  it("filters the installed grid on the scanner's verdict", async () => {
    await openStore("installed");
    expect(screen.getByText("PDF")).toBeTruthy();

    await tick("safety", "dangerous");

    await waitFor(() => expect(screen.queryByText("PDF")).toBeNull());
    expect(screen.getByText("Shell Helper")).toBeTruthy();
  });

  it("folds the old category select into the rail", async () => {
    await openStore("installed");
    expect(screen.queryByLabelText("Category", { selector: "select" })).toBeNull();

    await tick("category", "documents");
    await waitFor(() => expect(screen.queryByText("Shell Helper")).toBeNull());
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it("never offers `other` as a category, and still lists the skill filed under it", async () => {
    await openStore("installed");
    expect(screen.queryAllByTestId("hs-facet-category-other")).toHaveLength(0);
    expect(screen.getByText("Scratch")).toBeTruthy();
  });

  it("clear all brings the whole list back", async () => {
    await openStore("installed");
    await tick("trust", "community");
    await waitFor(() => expect(screen.queryByText("PDF")).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByTestId("hs-clear-all"));
    });
    await waitFor(() => expect(screen.getByText("PDF")).toBeTruthy());
  });
});

describe("the rail on a narrow store", () => {
  it("collapses into a button that opens a drawer, rather than squeezing the grid", async () => {
    await openStore("browse");
    const button = screen.getByTestId("hs-filters-button");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByTestId("hs-filters-drawer")).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });

    const drawer = screen.getByTestId("hs-filters-drawer");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(within(drawer).getByTestId("hs-facet-trust-official")).toBeTruthy();
    // The drawer titles itself, so the rail inside it must not title itself too.
    expect(within(drawer).getAllByText("Filters")).toHaveLength(1);
  });

  it("hides the column and the button at opposite widths, so only one is ever shown", async () => {
    await openStore("browse");
    // The container query is the whole mechanism, and jsdom does not evaluate
    // one — so the classes that carry it are what there is to pin.
    const column = document.querySelector(".w-56");
    expect(column?.className).toContain("hidden");
    expect(column?.className).toContain("@2xl:block");
    expect(screen.getByTestId("hs-filters-button").parentElement?.className).toContain("@2xl:hidden");
  });

  it("closes on Escape and gives focus back", async () => {
    await openStore("browse");
    const button = screen.getByTestId("hs-filters-button");
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("hs-filters-drawer"), { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("hs-filters-drawer")).toBeNull());
    expect(document.activeElement).toBe(button);
  });
});

describe("the rail from the keyboard", () => {
  it("is a real grouped checkbox list, so grouping and state are announced", async () => {
    await openStore("browse");
    const box = facetBox("trust", "official");
    expect(box.type).toBe("checkbox");
    const group = box.closest("fieldset");
    expect(group).toBeTruthy();
    expect(within(group as HTMLElement).getByText("Trust")).toBeTruthy();
  });

  it("ticks with the space bar", async () => {
    const user = userEvent.setup({ document });
    await openStore("browse");
    const box = facetBox("trust", "official");

    box.focus();
    expect(document.activeElement).toBe(box);
    await act(async () => {
      await user.keyboard("[Space]");
    });

    await waitFor(() => expect(facetBox("trust", "official").checked).toBe(true));
    await waitFor(() => expect(screen.queryByText("Community Charlie")).toBeNull());
  });

  it("announces the result count politely once the filter settles", async () => {
    await openStore("browse");
    await tick("trust", "official");
    await waitFor(() => expect(screen.getByText("1 skill matches")).toBeTruthy());

    await tick("trust", "community");
    await waitFor(() => expect(screen.getByText("4 skills match")).toBeTruthy());
  });

  it("says nothing on first paint, so opening the store is not narrated", async () => {
    await openStore("browse");
    expect(screen.queryByText(/skills? match/)).toBeNull();
  });

  it("says nothing when the TAB changes — that is not a filter change", async () => {
    await openStore("browse");
    await tick("trust", "official");
    await waitFor(() => expect(screen.getByText("1 skill matches")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-tab-installed"));
    });
    await waitFor(() => expect(screen.getByText("PDF")).toBeTruthy());
    // The other tab's count does not get read out, and the browse one does not
    // stay standing beside a list it no longer describes.
    expect(screen.queryByText(/skills? match/)).toBeNull();
  });
});
