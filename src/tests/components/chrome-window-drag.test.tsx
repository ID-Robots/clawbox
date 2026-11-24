import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef, useState } from "react";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow, { type WindowMode } from "@/components/ChromeWindow";

// Counted: every render of a window asks for the language once.
const renders = vi.hoisted(() => ({ windows: 0 }));
vi.mock("@/lib/i18n", () => ({
  useT: () => {
    renders.windows++;
    return { locale: "en", t: (key: string) => key };
  },
}));

/**
 * What a window costs the desktop around it while it is grabbed, dragged and
 * dropped — and that none of the savings shows.
 *
 * Pinned: a window is memoized, so a desktop render that hands it the same
 * props re-renders neither it nor its app, and its pointer listeners are
 * installed once whatever callbacks it is handed; a press that moves nothing
 * takes no compositor layer and tells the desktop nothing; a drag moves the
 * window by the `translate` property (never `transform`, which the open and
 * restore animations hold) from its first real move, and every way the drag
 * ends — a release, a touch the browser cancelled — gives the layer and the
 * offset back; a snap drop computes the drop point's style before the zone's
 * glide is committed, so the glide starts where the window was let go, and
 * lands on the zone even when its corner is where the window stood before the
 * drag (React writes no style it already rendered); and a snap drop is
 * reported once, as the change of mode, ending in the record the old two
 * reports ended in.
 */

const W = 1440;
const H = 900;
const SHELF = 56;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const noop = () => {};

function win(props: Partial<React.ComponentProps<typeof ChromeWindow>> = {}) {
  return render(
    <ChromeWindow
      title="Files"
      appId="files"
      windowId="files-1"
      isActive
      zIndex={100}
      onClose={noop}
      onFocus={noop}
      onMinimize={noop}
      initialPosition={{ x: 400, y: 200 }}
      initialSize={{ width: 600, height: 400 }}
      {...props}
    >
      <div>body</div>
    </ChromeWindow>,
  );
}

const el = () => screen.getByTestId("chrome-window-files");
const titleBar = () => screen.getByText("Files").parentElement!.parentElement!;
const content = () => el().querySelector<HTMLElement>("[data-chrome-window-content]")!;

describe("a window inside a desktop that re-renders", () => {
  it("re-renders neither itself nor its app when the desktop hands it the same props", () => {
    let appRenders = 0;
    function App() {
      appRenders++;
      return <div>app</div>;
    }
    const app = <App />;
    const props = {
      title: "Files", appId: "files", isActive: true, zIndex: 100,
      onClose: noop, onFocus: noop, onMinimize: noop,
      initialPosition: { x: 400, y: 200 }, initialSize: { width: 600, height: 400 },
    };
    // The desktop re-renders for something of its own — the shelf clock, a poll.
    function Desktop() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button data-testid="tick" data-tick={tick} onClick={() => setTick((n) => n + 1)} />
          <ChromeWindow {...props}>{app}</ChromeWindow>
        </>
      );
    }
    render(<Desktop />);
    const windowsBefore = renders.windows;
    const appsBefore = appRenders;
    fireEvent.click(screen.getByTestId("tick"));
    fireEvent.click(screen.getByTestId("tick"));
    expect(screen.getByTestId("tick")).toHaveAttribute("data-tick", "2");
    expect(renders.windows).toBe(windowsBefore);
    expect(appRenders).toBe(appsBefore);
  });

  it("still re-renders for a prop that changed", () => {
    const { rerender } = win({ isActive: true });
    const before = renders.windows;
    rerender(
      <ChromeWindow title="Files" appId="files" windowId="files-1" isActive={false} zIndex={100} onClose={noop} onFocus={noop} onMinimize={noop}
        initialPosition={{ x: 400, y: 200 }} initialSize={{ width: 600, height: 400 }}>
        <div>body</div>
      </ChromeWindow>,
    );
    expect(renders.windows).toBeGreaterThan(before);
    expect(el()).toHaveAttribute("data-active", "false");
  });

  it("installs its pointer listeners once, and reports to the callback it was handed last", () => {
    const add = vi.spyOn(window, "addEventListener");
    const first = vi.fn();
    const { rerender } = win({ onGeometryChange: first });
    const installs = () => add.mock.calls.filter(([type]) => type === "mouseup").length;
    const once = installs();
    const last = vi.fn();
    for (const report of [vi.fn(), vi.fn(), last]) {
      rerender(
        <ChromeWindow title="Files" appId="files" windowId="files-1" isActive zIndex={100} onClose={noop} onFocus={noop} onMinimize={noop}
          initialPosition={{ x: 400, y: 200 }} initialSize={{ width: 600, height: 400 }} onGeometryChange={report}>
          <div>body</div>
        </ChromeWindow>,
      );
    }
    expect(installs()).toBe(once);

    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: 800, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 800, clientY: 300 });
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledWith({ x: 500, y: 290, width: 600, height: 400 });
  });
});

describe("a press on the title bar that moves nothing", () => {
  it("takes no layer of its own and tells the desktop nothing", () => {
    const onGeometryChange = vi.fn();
    const onFocus = vi.fn();
    win({ onGeometryChange, onFocus });
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    expect(el().style.willChange).toBe("");
    fireEvent.mouseUp(window, { clientX: 700, clientY: 210 });
    expect(el().style.willChange).toBe("");
    expect(el().style.translate).toBe("");
    expect(onGeometryChange).not.toHaveBeenCalled();
    // Still asked to come forward: whether it already holds the top layer —
    // the chat shares the counter — is the desktop's to answer.
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("tells the desktop nothing either when it is let go where it was grabbed", () => {
    const onGeometryChange = vi.fn();
    win({ onGeometryChange });
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: 760, clientY: 260 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 210 });
    fireEvent.mouseUp(window, { clientX: 700, clientY: 210 });
    expect(onGeometryChange).not.toHaveBeenCalled();
    expect(el().style.left).toBe("400px");
  });
});

describe("dragging a window", () => {
  it("moves it by `translate` from the first real move, and gives the layer back at the drop", () => {
    const onGeometryChange = vi.fn();
    win({ onGeometryChange });
    // Grabbed while the opening animation — a `transform` with fill-mode
    // forwards — still runs: an inline transform would lose to it.
    expect(el().className).toContain("chrome-window-opening");
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: 800, clientY: 300 });
    expect(el().style.willChange).toBe("transform");
    expect(el().style.translate).toBe("100px 90px");
    expect(el().style.transform).toBe("");
    // No layout during the drag: left/top stay where the drag began.
    expect(el().style.left).toBe("400px");
    expect(el().style.top).toBe("200px");
    expect(content().style.pointerEvents).toBe("none");

    fireEvent.mouseUp(window, { clientX: 800, clientY: 300 });
    expect(el().style.willChange).toBe("");
    expect(el().style.translate).toBe("");
    expect(el().style.left).toBe("500px");
    expect(el().style.top).toBe("290px");
    expect(content().style.pointerEvents).toBe("");
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onGeometryChange).toHaveBeenCalledWith({ x: 500, y: 290, width: 600, height: 400 });
  });

  it("ends where it stands when the browser cancels the touch, snapping nothing", () => {
    const onGeometryChange = vi.fn();
    win({ onGeometryChange });
    fireEvent.touchStart(titleBar(), { touches: [{ clientX: 700, clientY: 210 }] });
    fireEvent.touchMove(window, { touches: [{ clientX: 800, clientY: 300 }] });
    expect(el().style.translate).toBe("100px 90px");
    // Over the right-hand snap zone when the browser takes the gesture.
    fireEvent.touchMove(window, { touches: [{ clientX: W - 2, clientY: 300 }] });
    fireEvent.touchCancel(window, { changedTouches: [{ clientX: W - 2, clientY: 300 }] });

    expect(el().style.willChange).toBe("");
    expect(el().style.translate).toBe("");
    expect(content().style.pointerEvents).toBe("");
    expect(el()).not.toHaveAttribute("data-snapped");
    expect(screen.queryByTestId("snap-preview")).toBeNull();
    // x: 400 + (1438 - 700), clamped to the screen.
    expect(el().style.left).toBe(`${W - 600}px`);
    expect(onGeometryChange).toHaveBeenCalledWith({ x: W - 600, y: 290, width: 600, height: 400 });

    // The gesture is over: the next touch elsewhere moves nothing.
    fireEvent.touchMove(window, { touches: [{ clientX: 100, clientY: 100 }] });
    expect(el().style.translate).toBe("");
    expect(el().style.left).toBe(`${W - 600}px`);
  });
});

/**
 * At devicePixelRatio 1.5 (a 4K monitor at scale 1.5) every odd CSS pixel is
 * half a device pixel: a window centred at `left: 347.5px`, or dragged or
 * resized by a whole number of CSS pixels, stood between device pixels and was
 * redrawn differently once the drag let it go. Centring, the drag and its
 * offset, and the resize all land on whole device pixels.
 */
describe("on the device pixel grid", () => {
  const DPR = 1.5;
  const onGrid = (v: number) => Math.abs(v * DPR - Math.round(v * DPR)) < 0.01;
  const px = (v: string) => v.split(" ").map((part) => parseFloat(part));
  const box = () => [el().style.left, el().style.top, el().style.width, el().style.height].map((v) => parseFloat(v));
  beforeEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: DPR, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });

  it("centres a new window on whole device pixels", () => {
    // A size already on the grid (806 x 602 is 1209 x 903 device px), centred
    // at (1440 - 806) / 2 = 317 and (844 - 602) / 2 = 121 CSS px: 475.5 and
    // 181.5 device px. Read at the FIRST commit, by the app inside the window,
    // before the window's own effects run: the frame it opens with.
    const first: number[] = [];
    function App() {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        const w = ref.current!.closest<HTMLElement>("[data-window-id]")!;
        first.push(parseFloat(w.style.left), parseFloat(w.style.top));
      }, []);
      return <div ref={ref} />;
    }
    render(
      <ChromeWindow title="Files" appId="files" windowId="files-1" isActive zIndex={100} onClose={noop} onFocus={noop}
        onMinimize={noop} defaultWidth={806} defaultHeight={602}>
        <App />
      </ChromeWindow>,
    );
    expect(first.length === 2 && first.every(onGrid), `${first}`).toBe(true);
    const [left, top] = box();
    expect(onGrid(left) && onGrid(top), `${left}, ${top}`).toBe(true);
  });

  it("drags it by whole device pixels, and drops it where the drag showed it", () => {
    const onGeometryChange = vi.fn();
    win({ onGeometryChange });
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: 801, clientY: 301 });
    const [dx, dy] = px(el().style.translate);
    expect(onGrid(dx) && onGrid(dy), el().style.translate).toBe(true);
    fireEvent.mouseUp(window, { clientX: 801, clientY: 301 });
    const [left, top] = box();
    expect(onGrid(left) && onGrid(top), `${left}, ${top}`).toBe(true);
    expect(left).toBeCloseTo(400 + dx, 6);
    expect(top).toBeCloseTo(200 + dy, 6);
    expect(onGeometryChange).toHaveBeenCalledWith({ x: expect.closeTo(left, 6), y: expect.closeTo(top, 6), width: 600, height: 400 });
  });

  it("resizes it by whole device pixels, the opposite edge staying where it was", () => {
    win();
    const handle = (cursor: string) => el().querySelector<HTMLElement>(`.${cursor}`)!;
    fireEvent.mouseDown(handle("cursor-se-resize"), { clientX: 1000, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: 1101, clientY: 701 });
    fireEvent.mouseUp(window, { clientX: 1101, clientY: 701 });
    let [left, top, width, height] = box();
    expect([width, height].every(onGrid), `${width} x ${height}`).toBe(true);
    expect([left, top]).toEqual([400, 200]);

    const right = left + width;
    const bottom = top + height;
    fireEvent.mouseDown(handle("cursor-nw-resize"), { clientX: 400, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 301, clientY: 101 });
    fireEvent.mouseUp(window, { clientX: 301, clientY: 101 });
    [left, top, width, height] = box();
    expect([left, top, width, height].every(onGrid), `${left}, ${top} ${width} x ${height}`).toBe(true);
    expect(left + width).toBeCloseTo(right, 6);
    expect(top + height).toBeCloseTo(bottom, 6);
  });

  it("holds a resize at the minimum size on whole device pixels too", () => {
    // At devicePixelRatio 1.125 the 300 px minimum width is 337.5 device px.
    const dpr = 1.125;
    Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
    const aligned = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 0.01;
    win();
    // The left edge dragged far right: held at the minimum, the right edge where it was.
    fireEvent.mouseDown(el().querySelector<HTMLElement>(".cursor-w-resize")!, { clientX: 400, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 900, clientY: 400 });
    fireEvent.mouseUp(window, { clientX: 900, clientY: 400 });
    const [left, , width] = box();
    expect(aligned(left) && aligned(width), `${left} + ${width}`).toBe(true);
    expect(width).toBeGreaterThanOrEqual(300);
    expect(width - 300).toBeLessThan(1 / dpr);
    expect(left + width).toBeCloseTo(1000, 6);
  });

  it("saves a size held at the minimum that the next window still takes, where the nearest device pixel is under it", () => {
    // At 1.331 the nearest device pixel to 300 is 299.8 CSS px, and a saved
    // size under 300 x 200 is refused: the window reopened at its default.
    const dpr = 1.331;
    Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
    const aligned = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 0.01;
    const { unmount } = win();
    fireEvent.mouseDown(el().querySelector<HTMLElement>(".cursor-se-resize")!, { clientX: 1000, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 100 });
    fireEvent.mouseUp(window, { clientX: 300, clientY: 100 });
    const [, , width, height] = box();
    expect(aligned(width) && aligned(height), `${width} x ${height}`).toBe(true);
    expect(width).toBeGreaterThanOrEqual(300);
    expect(height).toBeGreaterThanOrEqual(200);
    unmount();
    win({ initialPosition: undefined, initialSize: undefined });
    const [, , reopenedW, reopenedH] = box();
    expect([reopenedW, reopenedH]).toEqual([width, height]);
  });

  it.each([
    // Opened at the minimum height; only the right edge moves.
    ["height", { width: 600, height: 200 }, "cursor-e-resize", [1000, 300], [1050, 300]],
    // Opened at the minimum width; only the bottom edge moves.
    ["width", { width: 300, height: 400 }, "cursor-s-resize", [550, 600], [550, 650]],
  ] as const)("saves a FITTED %s at the minimum that the next window still takes, when the resize moves only the other edge", (_, initialSize, handle, from, to) => {
    // At 1.331 the nearest device pixel to 300 x 200 is 299.8 x 199.8 CSS px;
    // the edge the resize leaves alone is saved as it was fitted.
    const dpr = 1.331;
    Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
    const { unmount } = win({ initialSize });
    fireEvent.mouseDown(el().querySelector<HTMLElement>(`.${handle}`)!, { clientX: from[0], clientY: from[1] });
    fireEvent.mouseMove(window, { clientX: to[0], clientY: to[1] });
    fireEvent.mouseUp(window, { clientX: to[0], clientY: to[1] });
    const [, , width, height] = box();
    expect(width, `${width} x ${height}`).toBeGreaterThanOrEqual(300);
    expect(height, `${width} x ${height}`).toBeGreaterThanOrEqual(200);
    unmount();
    win({ initialPosition: undefined, initialSize: undefined });
    const [, , reopenedW, reopenedH] = box();
    // Fitted again on the way in: the same device pixel, give or take float noise.
    expect(reopenedW).toBeCloseTo(width, 6);
    expect(reopenedH).toBeCloseTo(height, 6);
  });
});

describe("a snap drop", () => {
  it("computes the drop point's style before the zone's glide is committed", () => {
    const seen: Array<{ left: string; translate: string }> = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((node: Element, pseudo?: string | null) => {
      if (node === el()) seen.push({ left: el().style.left, translate: el().style.translate });
      return real(node, pseudo);
    });
    win();
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: W - 2, clientY: 400 });
    seen.length = 0;
    fireEvent.mouseUp(window, { clientX: W - 2, clientY: 400 });

    // The glide's start value is the last style the browser computed: the
    // drop point, with the drag's offset gone — not the place it was grabbed.
    expect(seen).toContainEqual({ left: `${W - 600}px`, translate: "" });
    expect(el()).toHaveAttribute("data-snapped", "right");
    expect(el().style.left).toBe(`${W / 2}px`);
    expect(el().style.transition).toContain("left 0.2s");
  });

  it("lands on the zone when its corner is where the window stood before the drag, gliding from the drop point", () => {
    // A window at the top-left corner, snapped to the left half: the zone's
    // left/top are the very ones React last rendered, so React writes neither,
    // and the drop had already put the drop point there.
    const seen: string[] = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((node: Element, pseudo?: string | null) => {
      if (node === el()) seen.push(el().style.top);
      return real(node, pseudo);
    });
    win({ initialPosition: { x: 0, y: 0 } });
    // Every write of `top`, with the transition in force at that moment.
    const style = el().style;
    const proto = Object.getPrototypeOf(style) as object;
    const topProp = Object.getOwnPropertyDescriptor(proto, "top")!;
    const writes: Array<{ top: string; transition: string }> = [];
    Object.defineProperty(style, "top", {
      configurable: true,
      get: () => topProp.get!.call(style),
      set: (v: string) => {
        topProp.set!.call(style, v);
        writes.push({ top: style.top, transition: style.transition });
      },
    });

    fireEvent.mouseDown(titleBar(), { clientX: 300, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 2, clientY: 400 });
    fireEvent.mouseUp(window, { clientX: 2, clientY: 400 });

    expect(el()).toHaveAttribute("data-snapped", "left");
    expect(el().style.left).toBe("0px");
    expect(el().style.top).toBe("0px");
    expect(el().style.width).toBe(`${W / 2}px`);
    expect(el().style.height).toBe(`${H - SHELF}px`);
    // The glide's start is the drop point, computed before the zone's top is
    // written — and that write comes with the glide already on.
    expect(seen).toContain("390px");
    const landing = writes.filter((w) => w.top === "0px").at(-1);
    expect(landing?.transition).toContain("top 0.2s");
    delete (style as unknown as Record<string, unknown>).top;
  });

  it("computes nothing for a drop that does not snap", () => {
    const calls = vi.fn();
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((node: Element, pseudo?: string | null) => {
      if (node === el()) calls();
      return real(node, pseudo);
    });
    win();
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: 800, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 800, clientY: 300 });
    expect(calls).not.toHaveBeenCalled();
  });

  it("is reported once, as the change of mode, with the zone as the geometry and the drop point to go back to", () => {
    const onGeometryChange = vi.fn();
    const onModeChange = vi.fn<(mode: WindowMode) => void>();
    win({ onGeometryChange, onModeChange });
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: W - 2, clientY: 400 });
    fireEvent.mouseUp(window, { clientX: W - 2, clientY: 400 });

    expect(onGeometryChange).not.toHaveBeenCalled();
    expect(onModeChange).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith({
      maximized: false,
      snapped: "right",
      restore: { x: W - 600, y: 390, width: 600, height: 400 },
      geometry: { x: W / 2, y: 0, width: W / 2, height: H - SHELF },
    });

    // Grabbed out of the zone again and dropped: a change of mode, then the
    // free drop's own report — where the window ended up.
    fireEvent.mouseDown(titleBar(), { clientX: W * 0.75, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 700, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 700, clientY: 300 });
    expect(onModeChange).toHaveBeenLastCalledWith(expect.objectContaining({ snapped: null, restore: null }));
    expect(onGeometryChange).toHaveBeenCalledTimes(1);
    expect(onGeometryChange.mock.calls[0][0]).toMatchObject({ width: 600, height: 400 });
  });
});
