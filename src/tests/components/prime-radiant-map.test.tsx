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

let graph: Record<string, unknown>;
let glCalls: Array<[string, unknown[]]>;
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
        return /^create/.test(key) || key === "getUniformLocation" ? { name: key } : undefined;
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
    return ok({}, 404);
  }));
}

beforeEach(() => {
  graph = GRAPH;
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
  await waitFor(() => expect(screen.getByTestId("prime-radiant-map-status")).toHaveTextContent("Pages: 6"));
  return { ...view, onOpenPage, onIngest };
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

  it("lists orphans, hubs and bridges, and a click picks one out", async () => {
    await mount();
    const orphans = await screen.findByTestId("prime-radiant-map-insight-orphans");
    expect(orphans).toHaveTextContent("Office holidays");
    expect(orphans).toHaveTextContent("Loose note");
    expect(screen.getByTestId("prime-radiant-map-insight-hubs")).toHaveTextContent("Acme Widgets Ltd");
    fireEvent.click(within(orphans).getByText("Office holidays"));
    expect(await screen.findByTestId("prime-radiant-map-selected")).toHaveTextContent("Office holidays");
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
