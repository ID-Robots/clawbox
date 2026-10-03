import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TerminalApp, {
  PTY_RESIZE_INTERVAL_MS,
  RESIZE_TRANSITION_WATCHDOG_MS,
  watchResizeTransitions,
} from "@/components/TerminalApp";
import { resetTerminalSettingsStoreForTests } from "@/lib/terminal-settings";

/**
 * How often a terminal re-measures its grid, and how often the PTY hears about
 * it, while the window around it changes size.
 *
 * Pinned: a window GLIDING to a new size (a snap, the docked chat moving a
 * snapped window over) holds the fit back and fits once when the glide ends,
 * so the PTY — and the full-screen program behind it — hears one size, not
 * one per frame; a transition of something that does not hold the terminal
 * holds nothing; a glide whose end is never reported is let go after the
 * watchdog; and under an edge drag, which fits frame by frame as before, the
 * PTY is told at once and then at most once per PTY_RESIZE_INTERVAL_MS, the
 * size the grid settles on always last.
 */

interface Frame { type: string; cols?: number; rows?: number }
const sent: Frame[] = [];
let resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;
const fit = vi.fn();
const observers: Array<() => void> = [];
let frames: FrameRequestCallback[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    unicode = { activeVersion: "6" };
    constructor(options: Record<string, unknown>) { this.options = { ...options }; }
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    writeln() {}
    dispose() {}
    clear() {}
    getSelection() { return ""; }
    onData() { return { dispose: () => {} }; }
    onBell() { return { dispose: () => {} }; }
    onResize(fn: (size: { cols: number; rows: number }) => void) {
      resizeHandler = fn;
      return { dispose: () => { resizeHandler = null; } };
    }
    attachCustomKeyEventHandler() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { fit(); } } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/** Runs the animation frames asked for so far, as the browser's next frame would. */
function nextFrame() {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

/** The terminal's ResizeObserver fires: its element changed size this frame. */
function observedResize() {
  for (const cb of observers) cb();
}

function transition(target: Element, type: "transitionrun" | "transitionend" | "transitioncancel", propertyName: string) {
  act(() => {
    target.dispatchEvent(new TransitionEvent(type, { propertyName, bubbles: true }));
  });
}

const resizes = () => sent.filter((f) => f.type === "resize");

beforeEach(() => {
  sent.length = 0;
  observers.length = 0;
  frames = [];
  resizeHandler = null;
  fit.mockClear();
  resetTerminalSettingsStoreForTests();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const WebSocketStub = function () {
    return { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as Frame), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  } as unknown as typeof WebSocket;
  (WebSocketStub as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("WebSocket", WebSocketStub);
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: () => void) { observers.push(cb); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom lays nothing out: a terminal with no size is never fitted.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  resetTerminalSettingsStoreForTests();
});

/** A terminal inside a "window" frame, with a sibling panel beside it. */
async function mountInWindow() {
  render(
    <div data-testid="frame">
      <div data-testid="sidebar" />
      <div data-testid="body"><TerminalApp /></div>
    </div>,
  );
  await waitFor(() => expect(resizeHandler).not.toBeNull());
  await waitFor(() => expect(observers.length).toBeGreaterThan(0));
  nextFrame();
  fit.mockClear();
  return { frame: screen.getByTestId("frame"), sidebar: screen.getByTestId("sidebar") };
}

describe("a window gliding to a new size", () => {
  it("holds the fit for the whole glide and fits once when it ends", async () => {
    const { frame } = await mountInWindow();

    transition(frame, "transitionrun", "left");
    transition(frame, "transitionrun", "width");
    transition(frame, "transitionrun", "height");
    // Twelve frames of a 200 ms glide, each one resizing the terminal.
    for (let i = 0; i < 12; i++) {
      observedResize();
      nextFrame();
    }
    expect(fit).not.toHaveBeenCalled();

    transition(frame, "transitionend", "left");
    transition(frame, "transitionend", "width");
    nextFrame();
    // Still gliding: the height has not come to rest.
    expect(fit).not.toHaveBeenCalled();

    transition(frame, "transitionend", "height");
    nextFrame();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("fits frame by frame, as before, when nothing glides (an edge drag)", async () => {
    await mountInWindow();
    for (let i = 0; i < 3; i++) {
      observedResize();
      nextFrame();
    }
    expect(fit).toHaveBeenCalledTimes(3);
  });

  it("is not held by a transition of something beside it, or of a property that moves it", async () => {
    const { frame, sidebar } = await mountInWindow();
    transition(sidebar, "transitionrun", "width");
    transition(frame, "transitionrun", "top");
    observedResize();
    nextFrame();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("stays one glide when it is retargeted mid-way, whichever event comes first", async () => {
    const { frame } = await mountInWindow();
    transition(frame, "transitionrun", "width");
    observedResize();
    nextFrame();
    // The docked chat dragged wider: the new run arrives before the old one's cancel.
    transition(frame, "transitionrun", "width");
    transition(frame, "transitioncancel", "width");
    observedResize();
    nextFrame();
    expect(fit).not.toHaveBeenCalled();
    transition(frame, "transitionend", "width");
    nextFrame();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("tells the PTY one size for the glide", async () => {
    const { frame } = await mountInWindow();
    sent.length = 0;
    transition(frame, "transitionrun", "width");
    for (let i = 0; i < 12; i++) {
      observedResize();
      nextFrame();
    }
    transition(frame, "transitionend", "width");
    nextFrame();
    // The fit at the glide's end is the one grid change xterm reports.
    expect(fit).toHaveBeenCalledTimes(1);
    act(() => resizeHandler!({ cols: 200, rows: 50 }));
    expect(resizes()).toEqual([{ type: "resize", cols: 200, rows: 50 }]);
  });
});

describe("what the PTY hears while the grid keeps changing", () => {
  it("hears the first size at once, then the latest at most once per interval, the final one last", async () => {
    await mountInWindow();
    vi.useFakeTimers();
    sent.length = 0;

    act(() => resizeHandler!({ cols: 100, rows: 30 }));
    expect(resizes()).toEqual([{ type: "resize", cols: 100, rows: 30 }]);

    // An edge drag: a new grid every frame.
    act(() => {
      resizeHandler!({ cols: 101, rows: 30 });
      vi.advanceTimersByTime(16);
      resizeHandler!({ cols: 102, rows: 31 });
      vi.advanceTimersByTime(16);
      resizeHandler!({ cols: 103, rows: 31 });
    });
    expect(resizes()).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS); });
    expect(resizes()).toEqual([
      { type: "resize", cols: 100, rows: 30 },
      { type: "resize", cols: 103, rows: 31 },
    ]);

    // Quiet for longer than the interval: a lone resize (maximize) goes at once.
    act(() => { vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 2); });
    act(() => resizeHandler!({ cols: 160, rows: 40 }));
    expect(resizes().at(-1)).toEqual({ type: "resize", cols: 160, rows: 40 });
    expect(resizes()).toHaveLength(3);
  });

  it("is not held back by the wall clock stepping backwards (NTP on a box with no RTC)", async () => {
    await mountInWindow();
    vi.useFakeTimers();
    sent.length = 0;

    act(() => resizeHandler!({ cols: 100, rows: 30 }));
    expect(resizes()).toHaveLength(1);

    // NTP sets the clock back an hour. The monotonic clock does not move with
    // it; measured on the wall clock, the next resize would wait that hour.
    vi.setSystemTime(Date.now() - 3_600_000);
    act(() => { vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS * 2); });
    act(() => resizeHandler!({ cols: 120, rows: 35 }));
    expect(resizes()).toEqual([
      { type: "resize", cols: 100, rows: 30 },
      { type: "resize", cols: 120, rows: 35 },
    ]);

    // And a burst inside the interval after the step is still held for the
    // interval only, not for the size of the step.
    act(() => resizeHandler!({ cols: 121, rows: 35 }));
    expect(resizes()).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(PTY_RESIZE_INTERVAL_MS); });
    expect(resizes().at(-1)).toEqual({ type: "resize", cols: 121, rows: 35 });
  });
});

describe("watchResizeTransitions", () => {
  it("lets go of a glide whose end is never reported after the watchdog", () => {
    vi.useFakeTimers();
    const frame = document.createElement("div");
    const el = document.createElement("div");
    frame.appendChild(el);
    document.body.appendChild(frame);
    const settled = vi.fn();
    const watch = watchResizeTransitions(el, settled);
    try {
      frame.dispatchEvent(new TransitionEvent("transitionrun", { propertyName: "height", bubbles: true }));
      expect(watch.running()).toBe(true);
      vi.advanceTimersByTime(RESIZE_TRANSITION_WATCHDOG_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(watch.running()).toBe(false);
      // The end that finally arrives changes nothing.
      frame.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "height", bubbles: true }));
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      watch.dispose();
      frame.remove();
    }
  });

  it("ignores an end whose run it never saw, and hears nothing once disposed", () => {
    const frame = document.createElement("div");
    const el = document.createElement("div");
    frame.appendChild(el);
    document.body.appendChild(frame);
    const settled = vi.fn();
    const watch = watchResizeTransitions(el, settled);
    frame.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "width", bubbles: true }));
    expect(settled).not.toHaveBeenCalled();
    watch.dispose();
    frame.dispatchEvent(new TransitionEvent("transitionrun", { propertyName: "width", bubbles: true }));
    expect(watch.running()).toBe(false);
    frame.remove();
  });
});
