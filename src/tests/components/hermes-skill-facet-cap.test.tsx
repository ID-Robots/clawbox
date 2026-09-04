import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import HermesSkillsStore from "@/components/HermesSkillsStore";
import { MAX_FACET_SELECTION, MAX_FACET_VALUES } from "@/lib/hermes-skills";

/**
 * TASK-658 item 1 — the owner could CLICK their way into a 400.
 *
 * The browse route accepts at most MAX_FACET_SELECTION (12) values per facet
 * group; the rail renders up to MAX_FACET_VALUES (24). `toggleFacet` had no cap
 * of its own, so ticking a 13th value sent a request the route refused — and
 * the refusal carried no code, so the whole grid was replaced by "couldn't load
 * the catalogue, retry", whose button resends the same thirteen values.
 *
 * Capping it in the hook alone would trade that for a control that visibly
 * accepts a click and undoes it, so this drives the RAIL: the box the owner can
 * no longer tick has to say so.
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

/** A group with more options than the route will accept at once. */
const PROVIDERS = Array.from({ length: MAX_FACET_VALUES }, (_, i) => ({
  id: `p${i}`,
  label: `Provider ${i}`,
  count: MAX_FACET_VALUES - i,
}));

const browseBody = () => ({
  skills: [],
  page: 1,
  pageSize: 24,
  total: 0,
  totalPages: 0,
  hasMore: false,
  facets: { sources: [], providers: PROVIDERS, trust: [], categories: [] },
  categoryCoverage: 0,
  facetScope: "catalog",
  catalog: { origin: "index", skillCount: 1, fetchedAt: new Date().toISOString(), stale: false },
  degraded: false,
});

let urls: string[];

function server(browse: () => { ok: boolean; json: () => Promise<unknown> } = () => ({
  ok: true,
  json: async () => browseBody(),
})) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/skills/browse")) {
        urls.push(url);
        return browse();
      }
      return { ok: true, json: async () => ({ skills: [], counts: { total: 0 }, categories: [] }) };
    }),
  );
}

/** The rail is rendered twice — the column and the drawer's copy. Take the first. */
const box = (id: string) => screen.getAllByTestId(`hs-facet-provider-${id}`)[0] as HTMLInputElement;

async function openBrowse() {
  render(<HermesSkillsStore />);
  const tab = await screen.findByTestId("skill-tab-browse");
  await act(async () => {
    fireEvent.click(tab);
  });
  await waitFor(() => expect(screen.getAllByRole("group").length).toBeGreaterThan(0));
  await waitFor(() => expect(box("p0")).toBeTruthy());
  // The rail shows VISIBLE_OPTIONS before "Show N more"; the cap is above that,
  // so the whole group has to be on screen to reach it by clicking — which is
  // exactly how the owner reaches it.
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: /Show \d+ more/ })[0]);
  });
  await waitFor(() => expect(box(`p${MAX_FACET_SELECTION}`)).toBeTruthy());
}

async function tick(id: string) {
  await act(async () => {
    fireEvent.click(box(id));
  });
}

beforeEach(() => {
  urls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browse facet rail's own cap", () => {
  it("disables the boxes it will not accept, and says why", async () => {
    server();
    await openBrowse();

    for (let i = 0; i < MAX_FACET_SELECTION; i++) await tick(`p${i}`);

    // A box that is already on stays operable — unticking must always work.
    expect(box("p0").disabled).toBe(false);
    // The next one is not silently inert; it is visibly unavailable...
    expect(box(`p${MAX_FACET_SELECTION}`).disabled).toBe(true);
    // ...with the reason on screen rather than in a 400.
    expect(screen.getAllByText(`At most ${MAX_FACET_SELECTION} at a time.`).length).toBeGreaterThan(0);
  });

  it("never sends more values than the route will take", async () => {
    server();
    await openBrowse();

    for (let i = 0; i < MAX_FACET_SELECTION + 3; i++) await tick(`p${i}`);

    for (const url of urls) {
      const sent = new URL(url, "http://localhost").searchParams
        .getAll("provider")
        .flatMap((raw) => raw.split(","))
        .filter(Boolean);
      expect(sent.length).toBeLessThanOrEqual(MAX_FACET_SELECTION);
    }
  });

  it("unticks a value that is already on, once the cap is reached", async () => {
    server();
    await openBrowse();

    for (let i = 0; i < MAX_FACET_SELECTION; i++) await tick(`p${i}`);
    await tick("p0");

    expect(box("p0").checked).toBe(false);
    expect(box(`p${MAX_FACET_SELECTION}`).disabled).toBe(false);
  });
});

describe("the refusal card's Clear all filters button", () => {
  it("re-asks the route, even when nothing was ticked", async () => {
    // `invalid_argument` also covers `page`, `size` and `sort` — a stale bundle
    // sending a value a newer route no longer accepts. `setSelected(EMPTY)` is
    // a no-op there (same object reference, so the fetch key never moves), so
    // the button was the literal "resends nothing and changes nothing" case
    // this card is about.
    server(() => ({
      ok: false,
      json: async () => ({ error: "Invalid sort", code: "invalid_argument", field: "sort" }),
    }));
    render(<HermesSkillsStore />);
    const tab = await screen.findByTestId("skill-tab-browse");
    await act(async () => {
      fireEvent.click(tab);
    });

    const clear = await screen.findByRole("button", { name: "Clear all" });
    const before = urls.length;
    await act(async () => {
      fireEvent.click(clear);
    });

    await waitFor(() => expect(urls.length).toBeGreaterThan(before));
  });
});
