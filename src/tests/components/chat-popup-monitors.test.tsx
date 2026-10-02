import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { installHermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { setDeskScreens, type DeskScreen } from "@/lib/desktop-screens";
import { dockedChatWidth } from "@/lib/window-snap";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; every
// component suite that mounts it declares both ceilings (see
// `test-timeout-hygiene.test.ts`).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The mascot chat over a ROW of monitors (monitor mode): it docks to the MAIN
 * monitor and must stay on it, and floating it must stay on monitors someone
 * can see. With no layout — every Jetson, every browser tab — every number
 * here is the one it always was.
 */

const MON_W = 2560;
const MON_H = 1440;
/** The gutter the floating popup keeps from every edge; mirrored from the component. */
const MARGIN = 8;
const MIN_CHAT_WIDTH = 340;

function scr(id: string, x: number, y: number, width: number, height: number, main = false): DeskScreen {
  return { id, label: id, x, y, width, height, main };
}

/** The test machine: the main monitor on the left. */
const ROW = [scr("a", 0, 0, MON_W, MON_H, true), scr("b", MON_W, 0, MON_W, MON_H)];
/** A 1080p main beside a 1440p monitor: the strip under the main one is page no monitor shows. */
const MIXED = [scr("small", 0, 0, 1920, 1080, true), scr("big", 1920, 0, 2560, 1440)];

function setViewport(w: number, h: number) {
  window.innerWidth = w;
  window.innerHeight = h;
}

function stubRect(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: r.left, y: r.top, left: r.left, top: r.top,
    right: r.left + r.width, bottom: r.top + r.height,
    width: r.width, height: r.height,
    toJSON: () => ({}),
  } as DOMRect);
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  setViewport(2 * MON_W, MON_H);
  Element.prototype.scrollIntoView = vi.fn();
  installHermesBox();
});

afterEach(() => {
  cleanup();
  act(() => setDeskScreens(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("the docked chat's width over a row of monitors", () => {
  function dragLeftEdge(popup: HTMLElement, from: number, to: number) {
    const edge = popup.querySelector(".cursor-ew-resize") as HTMLElement;
    fireEvent.mouseDown(edge, { clientX: from, clientY: 600 });
    fireEvent.mouseMove(window, { clientX: to, clientY: 600 });
    fireEvent.mouseUp(window, { clientX: to, clientY: 600 });
  }

  it("is held to 60% of the main monitor, not of the whole row", async () => {
    act(() => setDeskScreens(ROW));
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />);
    const popup = await screen.findByTestId("chat-popup");
    stubRect(popup, { left: MON_W - 426, top: 6, width: 420, height: 1300 });
    // Dragged all the way to the main monitor's left edge.
    dragLeftEdge(popup, MON_W - 426, 0);
    expect(onPanelModeChange).toHaveBeenLastCalledWith(MON_W * 0.6);
    expect(popup.style.width).toBe(`${MON_W * 0.6}px`);
  });

  it("is held to 60% of the viewport with one screen, as it always was", async () => {
    setViewport(1440, 900);
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />);
    const popup = await screen.findByTestId("chat-popup");
    stubRect(popup, { left: 1014, top: 6, width: 420, height: 800 });
    dragLeftEdge(popup, 1014, 0);
    expect(onPanelModeChange).toHaveBeenLastCalledWith(1440 * 0.6);
  });

  it("draws a restored width wider than the main monitor's cap at the cap, and keeps the owner's width", async () => {
    // Persisted by a drag the old cap allowed: the whole main monitor. Drawn at
    // the cap — and the desktop reserves the same (`dockedChatWidth`) — but the
    // width is never rewritten: a main monitor narrow for a while (a trial, a
    // monitor off) must not cut the owner's width for good.
    act(() => setDeskScreens(ROW));
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={2500} onPanelModeChange={onPanelModeChange} />);
    const popup = await screen.findByTestId("chat-popup");
    expect(popup.style.width).toBe(`${Math.floor(MON_W * 0.6)}px`);
    expect(onPanelModeChange).not.toHaveBeenCalledWith(Math.floor(MON_W * 0.6));
    expect(dockedChatWidth(2500, true)).toBe(Math.floor(MON_W * 0.6));
    expect(dockedChatWidth(2500, false)).toBe(2500);
    // Back to one screen, the owner's width again.
    act(() => setDeskScreens(null));
    await waitFor(() => expect(popup.style.width).toBe("2500px"));
  });

  it("leaves a restored width alone with one screen", async () => {
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={2500} onPanelModeChange={onPanelModeChange} />);
    const popup = await screen.findByTestId("chat-popup");
    expect(popup.style.width).toBe("2500px");
    expect(onPanelModeChange).not.toHaveBeenCalled();
  });

  it("never goes below its own minimum on a small main monitor", async () => {
    setViewport(400 + MON_W, MON_H);
    act(() => setDeskScreens([scr("tiny", 0, 0, 400, 300, true), scr("b", 400, 0, MON_W, MON_H)]));
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />);
    const popup = await screen.findByTestId("chat-popup");
    expect(popup.style.width).toBe(`${MIN_CHAT_WIDTH}px`);
  });
});

describe("dragging the floating chat over a row of monitors", () => {
  const CHAT = { width: 520, height: 700 };

  it("keeps it out of the strip under a shorter monitor", async () => {
    setViewport(4480, MON_H);
    act(() => setDeskScreens(MIXED));
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    stubRect(popup, { left: 100, top: 300, ...CHAT });
    const header = screen.getByTestId("chat-header");
    fireEvent.pointerDown(header, { clientX: 200, clientY: 310 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 1310 });
    // The 1080 px main monitor's bottom, not the 1440 px row's.
    expect(popup.style.top).toBe(`${1080 - CHAT.height - MARGIN}px`);
    // On the tall monitor the same drag goes as far as its floor.
    fireEvent.pointerMove(window, { clientX: 3200, clientY: 1310 });
    expect(popup.style.top).toBe(`${MON_H - CHAT.height - MARGIN}px`);
    fireEvent.pointerUp(window, { clientX: 3200, clientY: 1310 });
  });

  it("draws the snap plate on the monitor the drop lands on", async () => {
    act(() => setDeskScreens(ROW));
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    stubRect(popup, { left: 1000, top: 300, ...CHAT });
    const header = screen.getByTestId("chat-header");
    fireEvent.pointerDown(header, { clientX: 1100, clientY: 310 });
    fireEvent.pointerMove(window, { clientX: 2 * MON_W - 3, clientY: 700 });
    const plate = screen.getByTestId("snap-preview");
    expect(plate.style.left).toBe(`${MON_W + MON_W / 2}px`);
    fireEvent.pointerUp(window, { clientX: 2 * MON_W - 3, clientY: 700 });
    expect(screen.queryByTestId("snap-preview")).toBeNull();
    expect(popup.style.left).toBe(`${MON_W + MON_W / 2}px`);
  });
});
