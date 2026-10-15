import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import PrimeRadiantMap from "@/components/PrimeRadiantMap";
import { I18nProvider } from "@/lib/i18n";
import { MapView } from "@/components/prime-radiant-map/view";
import { STATE_DIM, STATE_HIDDEN, STATE_MATCH, STATE_SELECTED } from "@/components/prime-radiant-map/renderer-gl";

/**
 * The Map tab over a fake graph route, with WebGL2 mocked: jsdom has no GPU,
 * so the context is a stand-in that records the draw calls. jsdom has no
 * Worker either, so the layout engine runs on the page (the fallback path) —
 * the real layout and Louvain, on a graph small enough to settle at once.
 * Fixtures are synthetic company data only.
 *
 * ISOLATED is the shape of the owner's vault that drew an empty map: pages
 * written from separate documents, so no links and no shared sources, two to
 * each of 24 domains.
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const GL = { LINES: 0x0001, TRIANGLE_STRIP: 0x0005, UNSIGNED_INT: 0x1405 } as const;

const GRAPH = {
  revision: "a".repeat(40),
  truncated: false,
  nodes: [
    { id: "entities/acme-widgets.md", title: "Acme Widgets Ltd", domain: "acme-sales", degree: 3, sources: 2 },
    { id: "concepts/widget-pricing.md", title: "Widget pricing", domain: "acme-sales", degree: 2, sources: 1 },
    { id: "concepts/acme-returns.md", title: "Acme returns", domain: "acme-sales", degree: 1, sources: 0 },
    { id: "concepts/support-hours.md", title: "Support hours", domain: "acme-support", degree: 2, sources: 1 },
    { id: "concepts/holidays.md", title: "Office holidays", domain: "acme-support", degree: 0, sources: 0 },
    { id: "notes/loose.md", title: "Loose note", domain: null, degree: 0, sources: 0 },
  ],
  edges: [[0, 1, 1], [0, 2, 1], [0, 3, 1], [1, 3, 0.5]],
};

/** 48 pages, no edges at all, 24 domains. */
const ISOLATED = {
  revision: "d".repeat(40),
  truncated: false,
  nodes: Array.from({ length: 48 }, (_, i) => ({ id: `notes/note-${i}.md`, title: `Note ${i}`, domain: `domain-${Math.floor(i / 2)}`, degree: 0, sources: 1 })),
  edges: [],
};

let graph: Record<string, unknown>;
let glCalls: Array<[string, unknown[]]>;
/** What `GET pages/<path>?view=summary` answers, by page; a page not listed answers 404. */
let summaryOf: Record<string, string | null>;
/** Holds the summary answers back until it resolves. */
let summaryGate: Promise<void> | null;
let contexts: string[];
let webgl: boolean;
let flat: boolean;

/** A WebGL2 context that accepts everything and records what is drawn. */
function fakeGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const answers: Record<string, unknown> = {
    canvas,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
  };
  return new Proxy({} as WebGL2RenderingContext, {
    get(_t, key: string) {
      if (key in answers) return answers[key];
      if (/^[A-Z0-9_]+$/.test(key)) return GL[key as keyof typeof GL] ?? 0x9000 + key.length;
      return (...args: unknown[]) => {
        glCalls.push([key, args]);
        // A uniform's location names the uniform, so a test can tell u_min from u_alpha.
        if (key === "getUniformLocation") return { name: args[1] };
        return /^create/.test(key) ? { name: key } : undefined;
      };
    },
  });
}

/** A 2D context that accepts everything. */
function fake2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_t, key: string) {
      if (key === "canvas") return canvas;
      return (...args: unknown[]) => {
        glCalls.push([`2d.${key}`, args]);
      };
    },
    set: () => true,
  });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const ok = (json: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => json });
    if (url.startsWith("/setup-api/preferences")) return ok({ ui_language: "en" });
    if (url === "/setup-api/prime-radiant/graph") return ok(graph);
    const page = /^\/setup-api\/prime-radiant\/pages\/(.+)\?view=summary$/.exec(url);
    if (page) {
      const id = decodeURIComponent(page[1]);
      if (summaryGate) await summaryGate;
      return id in summaryOf ? ok({ path: id, summary: summaryOf[id] }) : ok({ error: "No such page.", code: "not_found" }, 404);
    }
    return ok({}, 404);
  }));
}

beforeEach(() => {
  graph = GRAPH;
  summaryOf = {};
  summaryGate = null;
  glCalls = [];
  contexts = [];
  webgl = true;
  flat = true;
  installFetch();
  vi.stubGlobal("Path2D", class { moveTo() {} arc() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, type: string) {
    contexts.push(type);
    if (type === "webgl2") return webgl ? fakeGL(this) : null;
    if (type === "2d") return flat ? fake2D(this) : null;
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount(onOpenPage = vi.fn(), onIngest = vi.fn()) {
  const view = render(
    <I18nProvider>
      <PrimeRadiantMap revision={0} onOpenPage={onOpenPage} onIngest={onIngest} />
    </I18nProvider>,
  );
  // The first mount in a file pays for I18nProvider's catalogue import, which a
  // loaded runner can take longer than the default 5 s to finish.
  await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Pages: 6"), { timeout: 15_000 });
  return { ...view, onOpenPage, onIngest };
}

/** The arguments of every call to `fn` on a uniform called `name`, in order. */
function uniformCalls(fn: string, name: string): unknown[][] {
  return glCalls.filter(([k, a]) => k === fn && (a[0] as { name?: string } | null)?.name === name).map(([, a]) => a);
}

/** The node states the view was last handed. */
function lastStates(spy: { mock: { calls: unknown[][] } }): Uint8Array {
  return spy.mock.calls[spy.mock.calls.length - 1][0] as Uint8Array;
}

describe("PrimeRadiantMap", () => {
  it("draws every page in one instanced call and every edge in one line call", async () => {
    await mount();
    expect(screen.getByTestId("prime-radiant-map")).toHaveAttribute("data-mode", "webgl");
    expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Links: 3");
    await waitFor(() => expect(glCalls.some(([k]) => k === "drawArraysInstanced")).toBe(true));
    const nodes = glCalls.filter(([k]) => k === "drawArraysInstanced").pop()![1];
    expect(nodes).toEqual([GL.TRIANGLE_STRIP, 0, 4, 6]);
    const lines = glCalls.filter(([k]) => k === "drawElements").map(([, a]) => a);
    expect(lines).toContainEqual([GL.LINES, 8, GL.UNSIGNED_INT, 0]);
    // The layout settles (on the page here, in a worker in a browser) and stops saying so.
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).not.toHaveTextContent("Arranging"));
    expect(glCalls.some(([k]) => k === "bufferSubData")).toBe(true);
  });

  it("lights up the pages a search matches, lists them and opens the one picked", async () => {
    const setStates = vi.spyOn(MapView.prototype, "setStates");
    const flyTo = vi.spyOn(MapView.prototype, "flyTo");
    const { onOpenPage } = await mount();
    fireEvent.change(screen.getByTestId("prime-radiant-map-search"), { target: { value: "acme" } });
    expect(await screen.findByTestId("prime-radiant-map-match-count")).toHaveTextContent("Matching pages: 2");
    // Leaving the field folds the list away (it would cover the map); coming back opens it again.
    fireEvent.blur(screen.getByTestId("prime-radiant-map-search"));
    expect(screen.queryByTestId("prime-radiant-map-results")).toBeNull();
    fireEvent.focus(screen.getByTestId("prime-radiant-map-search"));
    const results = screen.getAllByTestId("prime-radiant-map-result");
    expect(results.map((r) => r.textContent)).toEqual([expect.stringContaining("Acme Widgets Ltd"), expect.stringContaining("Acme returns")]);
    await waitFor(() => expect(lastStates(setStates)[0]).toBe(STATE_MATCH));
    const states = lastStates(setStates);
    expect([...states]).toEqual([STATE_MATCH, STATE_DIM, STATE_MATCH, STATE_DIM, STATE_DIM, STATE_DIM]);
    // The camera flies to what matched.
    expect(flyTo).toHaveBeenCalledWith([0, 2]);

    fireEvent.click(results[1]);
    const card = await screen.findByTestId("prime-radiant-map-selected");
    expect(card).toHaveTextContent("Acme returns");
    expect(card).toHaveTextContent("concepts/acme-returns.md");
    // Picked out with its one neighbour.
    await waitFor(() => expect(lastStates(setStates)[2]).toBe(STATE_SELECTED));
    expect(lastStates(setStates)[0]).toBe(STATE_MATCH);
    expect(lastStates(setStates)[1]).toBe(STATE_DIM);

    fireEvent.click(within(card).getByTestId("prime-radiant-map-open"));
    expect(onOpenPage).toHaveBeenCalledWith("concepts/acme-returns.md");
    // Enter on the map opens the picked page too.
    fireEvent.keyDown(screen.getByTestId("prime-radiant-map-canvas"), { key: "Enter" });
    expect(onOpenPage).toHaveBeenCalledTimes(2);
  });

  it("says when nothing matches", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("prime-radiant-map-search"), { target: { value: "zebra" } });
    expect(await screen.findByTestId("prime-radiant-map-match-count")).toHaveTextContent("No page matches.");
  });

  it("selects a page on a click and opens it on a double click (two taps) on the canvas", async () => {
    const pick = vi.spyOn(MapView.prototype, "pick").mockReturnValue(3);
    const { onOpenPage } = await mount();
    const canvas = screen.getByTestId("prime-radiant-map-canvas");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(await screen.findByTestId("prime-radiant-map-selected")).toHaveTextContent("Support hours");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onOpenPage).toHaveBeenCalledWith("concepts/support-hours.md");
    // A click on empty space clears the selection.
    pick.mockReturnValue(-1);
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 5, clientY: 5 });
    await waitFor(() => expect(screen.queryByTestId("prime-radiant-map-selected")).toBeNull());
  });

  it("names the hovered page in a tooltip", async () => {
    vi.spyOn(MapView.prototype, "pick").mockReturnValue(1);
    await mount();
    fireEvent.pointerMove(screen.getByTestId("prime-radiant-map-canvas"), { pointerId: 1, pointerType: "mouse", clientX: 40, clientY: 50 });
    const tip = await screen.findByTestId("prime-radiant-map-tooltip");
    await waitFor(() => expect(tip).toHaveTextContent("Widget pricing"));
    expect(tip).toHaveTextContent("acme-sales");
  });

  it("hides a domain from the legend, and colours by community once the communities are in", async () => {
    const setStates = vi.spyOn(MapView.prototype, "setStates");
    const setColors = vi.spyOn(MapView.prototype, "setColors");
    await mount();
    fireEvent.click(screen.getByTestId("prime-radiant-map-legend-toggle"));
    const legend = screen.getByTestId("prime-radiant-map-legend");
    const support = within(legend).getAllByTestId("prime-radiant-map-domain").find((b) => b.textContent?.includes("acme-support"))!;
    expect(within(legend).getAllByTestId("prime-radiant-map-domain").map((b) => b.textContent)).toEqual(["acme-sales3", "acme-support2", "No domain1"]);
    fireEvent.click(support);
    expect(support).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(lastStates(setStates)[3]).toBe(STATE_HIDDEN));
    expect(lastStates(setStates)[4]).toBe(STATE_HIDDEN);
    expect(lastStates(setStates)[0]).toBe(0);

    const community = screen.getByTestId("prime-radiant-map-colour-community");
    await waitFor(() => expect(community).not.toBeDisabled());
    const before = setColors.mock.calls.length;
    fireEvent.click(community);
    expect(community).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(setColors.mock.calls.length).toBeGreaterThan(before));
  });

  it("keeps a hidden domain hidden when a new revision orders the legend differently", async () => {
    const setStates = vi.spyOn(MapView.prototype, "setStates");
    const { rerender } = await mount();
    fireEvent.click(screen.getByTestId("prime-radiant-map-legend-toggle"));
    const legend = screen.getByTestId("prime-radiant-map-legend");
    fireEvent.click(within(legend).getAllByTestId("prime-radiant-map-domain").find((b) => b.textContent?.includes("acme-support"))!);
    await waitFor(() => expect(lastStates(setStates)[3]).toBe(STATE_HIDDEN));

    // An ingest moved pages: acme-support now leads the legend.
    graph = {
      ...GRAPH,
      revision: "b".repeat(40),
      nodes: GRAPH.nodes.map((node, i) => ({ ...node, domain: i < 3 ? "acme-support" : i < 5 ? "acme-sales" : null })),
    };
    rerender(
      <I18nProvider>
        <PrimeRadiantMap revision={1} onOpenPage={vi.fn()} onIngest={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(within(screen.getByTestId("prime-radiant-map-legend")).getAllByTestId("prime-radiant-map-domain").map((b) => b.textContent)).toEqual([
        "acme-support3",
        "acme-sales2",
        "No domain1",
      ]),
    );
    const support = within(screen.getByTestId("prime-radiant-map-legend")).getAllByTestId("prime-radiant-map-domain")[0];
    expect(support).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect([...lastStates(setStates)].map((s) => s === STATE_HIDDEN)).toEqual([true, true, true, false, false, false]));
  });

  it("stands the page list in when the layout cannot load at all", async () => {
    // What the port reports when neither the worker nor the engine's chunk loads: no positions, ever.
    vi.spyOn(MapView.prototype, "load").mockImplementation(function (this: MapView) {
      (this as unknown as { events: { onLayoutFailed(): void } }).events.onLayoutFailed();
    });
    await mount();
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map")).toHaveAttribute("data-mode", "none"));
    expect(screen.getByTestId("prime-radiant-map-status")).not.toHaveTextContent("Arranging");
  });

  it("keeps orphans, hubs and bridges behind one Insights button on the map, and a click picks one out", async () => {
    await mount();
    // No strip under the map: the canvas has that room.
    expect(screen.queryByTestId("prime-radiant-map-insights")).toBeNull();
    const button = screen.getByTestId("prime-radiant-map-insights-toggle");
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const orphans = await screen.findByTestId("prime-radiant-map-insight-orphans");
    expect(orphans).toHaveTextContent("Office holidays");
    expect(orphans).toHaveTextContent("Loose note");
    expect(screen.getByTestId("prime-radiant-map-insight-hubs")).toHaveTextContent("Acme Widgets Ltd");
    expect(screen.getByTestId("prime-radiant-map-insight-bridges")).toBeInTheDocument();
    fireEvent.click(within(orphans).getByText("Office holidays"));
    expect(await screen.findByTestId("prime-radiant-map-selected")).toHaveTextContent("Office holidays");
    // Escape folds it away and gives the focus back to the button.
    fireEvent.keyDown(screen.getByTestId("prime-radiant-map-insights"), { key: "Escape" });
    expect(screen.queryByTestId("prime-radiant-map-insights")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("keeps one compact row above the map: the search, the colouring and the fit button", async () => {
    await mount();
    const row = screen.getByTestId("prime-radiant-map-toolbar");
    expect(row.children).toHaveLength(3);
    expect(within(row).getByTestId("prime-radiant-map-search")).toBeInTheDocument();
    expect(within(row).getByTestId("prime-radiant-map-colour-community")).toBeInTheDocument();
    expect(within(row).getByTestId("prime-radiant-map-fit")).toBeInTheDocument();
    expect(within(row).queryAllByTestId("prime-radiant-map-domain")).toHaveLength(0);
  });

  it("folds the domain legend into a corner of the map, closed until asked for", async () => {
    const setStates = vi.spyOn(MapView.prototype, "setStates");
    await mount();
    const toggle = screen.getByTestId("prime-radiant-map-legend-toggle");
    expect(screen.queryByTestId("prime-radiant-map-legend")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Domains3");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(screen.getByTestId("prime-radiant-map-legend")).getAllByTestId("prime-radiant-map-domain")[2]);
    await waitFor(() => expect(lastStates(setStates)[5]).toBe(STATE_HIDDEN));
    // Folded again, it still says something is hidden; the domain stays hidden.
    fireEvent.keyDown(screen.getByTestId("prime-radiant-map-legend"), { key: "Escape" });
    expect(screen.queryByTestId("prime-radiant-map-legend")).toBeNull();
    expect(toggle).toHaveTextContent("1 hidden");
    expect(lastStates(setStates)[5]).toBe(STATE_HIDDEN);
  });

  it("shows the arrow over the map, a hand over a page and a move cross while dragging — never a grab hand", async () => {
    const pick = vi.spyOn(MapView.prototype, "pick").mockReturnValue(-1);
    await mount();
    // The view listens once it has drawn (its effect may run just after the status shows).
    await waitFor(() => expect(glCalls.some(([k]) => k === "drawArraysInstanced")).toBe(true));
    const canvas = screen.getByTestId("prime-radiant-map-canvas");
    expect(canvas.className).not.toMatch(/grab/);
    expect(canvas).toHaveClass("cursor-default");
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 40, clientY: 50 });
    expect(["", "default"]).toContain(canvas.style.cursor);
    pick.mockReturnValue(1);
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 41, clientY: 50 });
    expect(canvas.style.cursor).toBe("pointer");
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "mouse", clientX: 41, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 90, clientY: 80 });
    expect(canvas.style.cursor).toBe("move");
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "mouse", clientX: 90, clientY: 80 });
    expect(canvas.style.cursor).toBe("default");
    for (const shape of [canvas.style.cursor, getComputedStyle(canvas).cursor]) expect(shape).not.toMatch(/grab/);
  });

  it("forgets the hovered page when the camera flies elsewhere, so no tooltip or hand is left over empty space", async () => {
    vi.spyOn(MapView.prototype, "pick").mockReturnValue(1);
    await mount();
    await waitFor(() => expect(glCalls.some(([k]) => k === "drawArraysInstanced")).toBe(true));
    const canvas = screen.getByTestId("prime-radiant-map-canvas");
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 40, clientY: 50 });
    const tip = screen.getByTestId("prime-radiant-map-tooltip");
    await waitFor(() => expect(tip).toHaveTextContent("Widget pricing"));
    expect(canvas.style.cursor).toBe("pointer");
    // The search flies to another page: the one that was under the pointer has moved away.
    const search = screen.getByTestId("prime-radiant-map-search");
    fireEvent.change(search, { target: { value: "holidays" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await screen.findByTestId("prime-radiant-map-selected")).toHaveTextContent("Office holidays");
    await waitFor(() => expect(tip).toHaveClass("hidden"));
    expect(canvas.style.cursor).toBe("default");
  });

  it("draws 48 pages with no links at all: every one in view, never a speck, on a canvas a screenshot can read", async () => {
    graph = ISOLATED;
    render(
      <I18nProvider>
        <PrimeRadiantMap revision={0} onOpenPage={vi.fn()} onIngest={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Pages: 48 · Links: 0"), { timeout: 15_000 });
    expect(screen.queryByTestId("prime-radiant-map-related")).toBeNull();
    // The Screenshot app reads a canvas with drawImage between frames: without this a WebGL canvas reads back empty.
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith("webgl2", expect.objectContaining({ preserveDrawingBuffer: true }));
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).not.toHaveTextContent("Arranging"));

    // One nodes draw for all 48, and no edge draw (there are none).
    await waitFor(() => expect(glCalls.some(([k, a]) => k === "drawArraysInstanced" && a[3] === 48)).toBe(true));
    expect(glCalls.filter(([k]) => k === "drawArraysInstanced").pop()![1]).toEqual([GL.TRIANGLE_STRIP, 0, 4, 48]);
    expect(glCalls.some(([k]) => k === "drawElements")).toBe(false);

    // The camera is finite and, once it has eased in, frames every page.
    const inView = () => {
      const vp = uniformCalls("uniformMatrix4fv", "u_vp").pop()![2] as Float32Array;
      const pos = glCalls.filter(([k]) => k === "bufferSubData").pop()![1][2] as Float32Array;
      expect([...vp].every(Number.isFinite)).toBe(true);
      expect(pos).toHaveLength(48 * 3);
      for (let i = 0; i < 48; i++) {
        const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        expect([x, y, z].every(Number.isFinite)).toBe(true);
        const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        expect(w).toBeGreaterThan(0);
        expect(Math.abs((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w)).toBeLessThanOrEqual(1);
        expect(Math.abs((vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w)).toBeLessThanOrEqual(1);
      }
    };
    await waitFor(inView, { timeout: 5_000 });
    // A page with no links is the smallest node there is: it still gets a dot you can see (CSS px × DPR 1).
    const min = uniformCalls("uniform1f", "u_min").pop()![1] as number;
    expect(min).toBeGreaterThanOrEqual(3);
    expect(Number.isFinite(uniformCalls("uniform1f", "u_scale").pop()![1] as number)).toBe(true);
  });

  it("never starts a map again from the origin it was left at before the layout answered", async () => {
    graph = ISOLATED;
    // Left at once: the layout never answered, so every page is still at the origin.
    const silent = vi.spyOn(MapView.prototype, "load").mockImplementation(() => {});
    const first = render(
      <I18nProvider>
        <PrimeRadiantMap revision={0} onOpenPage={vi.fn()} onIngest={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(silent).toHaveBeenCalled(), { timeout: 15_000 });
    first.unmount();
    silent.mockRestore();

    const load = vi.spyOn(MapView.prototype, "load");
    graph = { ...ISOLATED, revision: "9".repeat(40) };
    render(
      <I18nProvider>
        <PrimeRadiantMap revision={1} onOpenPage={vi.fn()} onIngest={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalled());
    const warm = load.mock.calls[0][1];
    const known = warm ? [...warm.known.keys()].filter((i) => warm.known[i]) : [];
    // Whatever is kept for these pages is a real layout — 48 pages with no edge, started at one spot, never part.
    const spots = new Set(known.map((i) => `${warm!.positions[i * 3]},${warm!.positions[i * 3 + 1]},${warm!.positions[i * 3 + 2]}`));
    expect(known.length === 0 || spots.size > 1).toBe(true);
  });

  it("draws the related hints fainter, in a pass of their own, and never counts them as links", async () => {
    graph = { ...GRAPH, revision: "e".repeat(40), edges: [[0, 1, 1], [0, 3, 0.5], [2, 4, 0.25], [4, 5, 0.25]] };
    await mount();
    expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Links: 1");
    // Counted apart, and said what they are.
    const related = screen.getByTestId("prime-radiant-map-related");
    expect(related).toHaveTextContent("Related: 2");
    expect(related).toHaveAttribute("title", expect.stringContaining("not links"));
    // Nothing picked out (a page kept from another visit would add its own lit edges).
    fireEvent.keyDown(screen.getByTestId("prime-radiant-map-canvas"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("prime-radiant-map-selected")).toBeNull());
    glCalls = [];
    await waitFor(() => expect(glCalls.filter(([k]) => k === "drawElements").length).toBeGreaterThanOrEqual(2));
    // Per frame: the hints (2 edges), then the links and shared sources (2 edges); the alpha set before each.
    let alpha = 0;
    const seen: Array<[number, number]> = [];
    for (const [k, a] of glCalls) {
      if (k === "uniform1f" && (a[0] as { name?: string }).name === "u_alpha") alpha = a[1] as number;
      if (k === "drawElements") seen.push([a[1] as number, alpha]);
    }
    const [weak, strong] = seen.slice(-2);
    expect(weak[0]).toBe(4);
    expect(strong[0]).toBe(4);
    expect(weak[1]).toBeLessThan(strong[1]);
    expect(weak[1]).toBeGreaterThan(0);
  });

  it("says what a picked page is about, asked for only then, and leaves no empty box for a page without prose", async () => {
    graph = { ...GRAPH, revision: "f".repeat(40) };
    summaryOf = {
      "concepts/support-hours.md": "Support answers on weekdays from nine to five. Urgent tickets go to the on-call engineer.",
      "concepts/widget-pricing.md": null,
    };
    let release!: () => void;
    summaryGate = new Promise<void>((r) => (release = r));
    const pick = vi.spyOn(MapView.prototype, "pick").mockReturnValue(3);
    await mount();
    await waitFor(() => expect(glCalls.some(([k]) => k === "drawArraysInstanced")).toBe(true));
    const asked = () => vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes("?view=summary"));
    expect(asked().some((u) => u.includes("support-hours"))).toBe(false);

    const canvas = screen.getByTestId("prime-radiant-map-canvas");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    const card = await screen.findByTestId("prime-radiant-map-selected");
    expect(card).toHaveTextContent("Support hours");
    // A small line while it comes, then the text; "Open page" stays for the rest.
    expect(within(card).getByTestId("prime-radiant-map-summary-loading")).toHaveTextContent("Reading the page…");
    release();
    expect(await within(card).findByTestId("prime-radiant-map-summary")).toHaveTextContent("Support answers on weekdays from nine to five.");
    expect(within(card).queryByTestId("prime-radiant-map-summary-loading")).toBeNull();
    expect(within(card).getByTestId("prime-radiant-map-open")).toBeInTheDocument();
    expect(asked().filter((u) => u.endsWith("/pages/concepts/support-hours.md?view=summary"))).toHaveLength(1);

    // A page with no prose: once read, no box at all.
    pick.mockReturnValue(1);
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 200, clientY: 100 });
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map-selected")).toHaveTextContent("Widget pricing"));
    await waitFor(() => expect(screen.queryByTestId("prime-radiant-map-summary-loading")).toBeNull());
    expect(screen.queryByTestId("prime-radiant-map-summary")).toBeNull();

    // Picked again, the first page answers from the cache, at once.
    pick.mockReturnValue(3);
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 300, clientY: 100 });
    expect(await screen.findByTestId("prime-radiant-map-summary")).toHaveTextContent("Urgent tickets");
    expect(asked().filter((u) => u.includes("support-hours"))).toHaveLength(1);
  });

  it("gives a screen reader the pages as a list that opens them", async () => {
    const { onOpenPage } = await mount();
    const list = screen.getByTestId("prime-radiant-map-list");
    expect(list).toHaveClass("sr-only");
    const items = within(list).getAllByRole("button");
    expect(items[0]).toHaveTextContent("Acme Widgets Ltd — acme-sales, Connections: 3");
    fireEvent.click(items[0]);
    expect(onOpenPage).toHaveBeenCalledWith("entities/acme-widgets.md");
  });

  it("draws a flat 2D canvas where WebGL2 is not there", async () => {
    webgl = false;
    await mount();
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map")).toHaveAttribute("data-mode", "2d"));
    expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Flat view");
    expect(contexts).toEqual(["webgl2", "2d"]);
    await waitFor(() => expect(glCalls.some(([k]) => k === "2d.fill")).toBe(true));
  });

  it("draws flat, without ever asking for WebGL, for an owner who prefers less motion", async () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({ matches: query.includes("reduced-motion"), media: query } as MediaQueryList));
    await mount();
    expect(screen.getByTestId("prime-radiant-map")).toHaveAttribute("data-mode", "2d");
    expect(contexts).not.toContain("webgl2");
  });

  it("lists the pages in plain sight where no canvas can draw at all", async () => {
    webgl = false;
    flat = false;
    await mount();
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map")).toHaveAttribute("data-mode", "none"));
    expect(screen.getByTestId("prime-radiant-map-list")).not.toHaveClass("sr-only");
    expect(screen.getByText("This browser cannot draw the map; the pages are listed below.")).toBeInTheDocument();
  });

  it("asks for documents when the vault has no pages", async () => {
    graph = { revision: "b".repeat(40), truncated: false, nodes: [], edges: [] };
    const onIngest = vi.fn();
    render(
      <I18nProvider>
        <PrimeRadiantMap revision={0} onOpenPage={vi.fn()} onIngest={onIngest} />
      </I18nProvider>,
    );
    const empty = await screen.findByTestId("prime-radiant-map-empty");
    await waitFor(() => expect(empty).toHaveTextContent("Nothing to map yet"));
    fireEvent.click(within(empty).getByRole("button"));
    expect(onIngest).toHaveBeenCalled();
    expect(contexts).toEqual([]);
  });

  it("offers a retry when the graph cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/setup-api/preferences")) return { ok: true, status: 200, json: async () => ({ ui_language: "en" }) };
      return { ok: false, status: 500, json: async () => ({ error: "The Prime Radiant vault could not be read.", code: "vault_unavailable" }) };
    }));
    render(
      <I18nProvider>
        <PrimeRadiantMap revision={0} onOpenPage={vi.fn()} onIngest={vi.fn()} />
      </I18nProvider>,
    );
    const box = await screen.findByTestId("prime-radiant-map-error");
    installFetch();
    fireEvent.click(within(box).getByRole("button"));
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Pages: 6"));
  });

  it("draws a 5,000-page graph with the same two calls", async () => {
    const n = 5000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `concepts/p${i}.md`, title: `Page ${i}`, domain: `d${i % 12}`, degree: 0, sources: 0 }));
    const edges: number[][] = [];
    for (let i = 1; i < n; i++) for (const j of [Math.floor(i / 2), Math.floor(i / 3), (i * 7919) % i]) if (j !== i) edges.push([Math.min(i, j), Math.max(i, j), 1]);
    graph = { revision: "c".repeat(40), truncated: false, nodes, edges: edges.slice(0, 20_000) };
    render(
      <I18nProvider>
        <PrimeRadiantMap revision={0} onOpenPage={vi.fn()} onIngest={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Pages: 5000"));
    await waitFor(() => expect(glCalls.some(([k, a]) => k === "drawArraysInstanced" && a[3] === n)).toBe(true));
    const draws = glCalls.filter(([k]) => k === "drawArraysInstanced" || k === "drawElements");
    // Per frame: one node call and one edge call, whatever the size.
    const frames = draws.filter(([k]) => k === "drawArraysInstanced").length;
    expect(draws.length).toBe(frames * 2);
    // The screen-reader list stays bounded.
    expect(within(screen.getByTestId("prime-radiant-map-list")).getAllByRole("button")).toHaveLength(300);
  });
});
