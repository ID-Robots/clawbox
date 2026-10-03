// What a render of the mascot chat costs, and what is allowed to cause one.
//
// ChatPopup is one very large component. A render of it used to parse the
// Markdown of every reply in the conversation again, and renders came from
// everywhere: each keystroke in the composer, a clock ticking once a second
// for the whole of a turn, and every pointer event of a drag or a resize of
// the floating chat (about sixty a second). These pin, on the real popup:
//
//   - a render no longer parses the conversation (the rows are memoised);
//   - a drag or a resize moves the popup on the DOM and commits ONE render at
//     the end, landing exactly where the per-move renders landed;
//   - the turn clock ticks without rendering the popup.
//
// The popup's renders are counted through `useKioskBarInset`, a hook it calls
// once per render and that nothing else mounted here uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

// See test-timeout-hygiene.test.ts: a jsdom mount of ChatPopup costs seconds
// under a full parallel run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const counters = vi.hoisted(() => ({ popupRenders: 0 }));

vi.mock("@/lib/chat-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-markdown")>();
  return { ...actual, renderText: vi.fn(actual.renderText) };
});
vi.mock("@/lib/kiosk-bar-inset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kiosk-bar-inset")>();
  return {
    ...actual,
    useKioskBarInset: () => {
      counters.popupRenders += 1;
      return actual.useKioskBarInset();
    },
  };
});

import { renderText } from "@/lib/chat-markdown";

const parses = () => vi.mocked(renderText).mock.calls.length;
const VIEWPORT = { w: 1440, h: 900 };
// What the rect falls back to for a side the inline style does not set: an
// unplaced popup hangs from `bottom`, so it has no `top` of its own.
const START = { left: 300, top: 200, width: 520, height: 680 };

/**
 * A layout for the popup jsdom does not have: the rect follows whatever the
 * last writer — React or a gesture — put in its inline style, the way a
 * browser's would.
 */
function followStyleRect(el: HTMLElement) {
  vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => {
    const px = (v: string, fallback: number) => (v.endsWith("px") ? Number.parseFloat(v) : fallback);
    const left = px(el.style.left, START.left);
    const top = px(el.style.top, START.top);
    const width = px(el.style.width, START.width);
    const height = px(el.style.height, START.height);
    return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
  });
}

let box: HermesBox;

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  window.innerWidth = VIEWPORT.w;
  window.innerHeight = VIEWPORT.h;
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(renderText).mockClear();
  counters.popupRenders = 0;
  box = installHermesBox();
  box.storedTranscript = [
    { role: "user", text: "What is on the box?", timestamp: 1 },
    { role: "assistant", text: "## Disk\n\n- **root**: 40 GB free\n- data: 12 GB", timestamp: 2 },
    { role: "user", text: "And memory?", timestamp: 3 },
    { role: "assistant", text: "| kind | free |\n|---|---|\n| RAM | 3.1 GB |\n| swap | 8 GB |", timestamp: 4 },
  ];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("typing in the composer", () => {
  it("renders the popup without parsing the conversation again", async () => {
    const composer = await mountHermesChat(box);
    await screen.findByRole("heading", { name: "Disk" });
    await screen.findByText("RAM");
    const parsed = parses();
    const renders = counters.popupRenders;

    for (const value of ["H", "He", "Hel", "Hell", "Hello"]) {
      fireEvent.change(composer, { target: { value } });
    }

    expect((composer as HTMLTextAreaElement).value).toBe("Hello");
    // The keystrokes did render the popup — which is what made them expensive.
    expect(counters.popupRenders).toBeGreaterThanOrEqual(renders + 5);
    expect(parses()).toBe(parsed);
  });
});

describe("dragging the floating chat", () => {
  async function openPopup() {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    // Up and settled: the entrance burst is on, as it is on a real open.
    await waitFor(() => expect(popup.style.opacity).toBe("1"));
    followStyleRect(popup);
    return popup;
  }

  it("follows the pointer without a render per move, and is committed where it was dropped", async () => {
    const popup = await openPopup();
    const start = popup.getBoundingClientRect();
    const header = screen.getByTestId("chat-header");
    fireEvent.pointerDown(header, { clientX: 500, clientY: 300 });
    const renders = counters.popupRenders;

    // Left and up: the popup opens against the right-hand gutter.
    for (let i = 1; i <= 12; i++) {
      fireEvent.pointerMove(window, { clientX: 500 - i * 10, clientY: 300 - i * 5 });
      expect(popup.style.left).toBe(`${start.left - i * 10}px`);
      expect(popup.style.top).toBe(`${start.top - i * 5}px`);
    }
    // Placed, not hanging from the mascot any more: the styles a placed
    // popup renders with, written by the move itself.
    expect(popup.style.bottom).toBe("auto");
    expect(popup.style.maxHeight).toBe("calc(100vh - 60px)");
    expect(counters.popupRenders).toBe(renders);

    fireEvent.pointerUp(window, { clientX: 380, clientY: 240 });
    expect(counters.popupRenders).toBeGreaterThan(renders);

    // A later render — a keystroke here — keeps it where it was let go,
    // because that is now the popup's own state, not just its DOM.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(popup.style.left).toBe(`${start.left - 120}px`);
    expect(popup.style.top).toBe(`${start.top - 60}px`);
  });

  it("takes the entrance burst off for the rest of this opening, instead of replaying it after the drop", async () => {
    const popup = await openPopup();
    expect(popup.style.animation).toContain("clawChatBurstIn");

    fireEvent.pointerDown(screen.getByTestId("chat-header"), { clientX: 500, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 460, clientY: 280 });
    expect(popup.style.animation).toBe("");
    fireEvent.pointerUp(window, { clientX: 460, clientY: 280 });

    // The render after a drop used to put the burst back, and the popup burst
    // out of the mascot again from wherever it had been dropped.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(popup.style.animation).toBe("");
  });

  it("still snaps where it is dropped against an edge", async () => {
    const popup = await openPopup();
    fireEvent.pointerDown(screen.getByTestId("chat-header"), { clientX: 500, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 400 });
    expect(screen.getByTestId("snap-preview")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 2, clientY: 400 });

    expect(screen.queryByTestId("snap-preview")).toBeNull();
    // The left half of the screen, held to the chat's own minimum width.
    expect(popup.style.left).toBe("0px");
    expect(Number.parseFloat(popup.style.width)).toBeGreaterThanOrEqual(VIEWPORT.w / 2);
  });

  it("keeps the desktop's notices out of its way while it moves, once a frame", async () => {
    const onFloatingRectChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} onFloatingRectChange={onFloatingRectChange} />);
    const popup = await screen.findByTestId("chat-popup");
    await waitFor(() => expect(popup.style.opacity).toBe("1"));
    followStyleRect(popup);
    const start = popup.getBoundingClientRect();

    fireEvent.pointerDown(screen.getByTestId("chat-header"), { clientX: 500, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 460, clientY: 270 });

    // Mid-gesture: nothing has been committed, and the desktop already knows.
    await waitFor(() => expect(onFloatingRectChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: start.left - 40, top: start.top - 30 }),
    ));
    fireEvent.pointerUp(window, { clientX: 460, clientY: 270 });
  });
});

describe("resizing the floating chat", () => {
  it("writes the size straight to the popup and commits it once, on release", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    followStyleRect(popup);
    const start = popup.getBoundingClientRect();
    const corner = popup.querySelector(".cursor-se-resize") as HTMLElement;
    fireEvent.mouseDown(corner, { clientX: start.right, clientY: start.bottom });
    const renders = counters.popupRenders;

    // Smaller: the popup opens against the right-hand gutter, so the corner
    // has no room to grow it.
    for (let i = 1; i <= 8; i++) {
      fireEvent.mouseMove(window, { clientX: start.right - i * 10, clientY: start.bottom - i * 20 });
    }
    expect(popup.style.width).toBe(`${start.width - 80}px`);
    expect(popup.style.height).toBe(`${start.height - 160}px`);
    expect(counters.popupRenders).toBe(renders);
    // Nothing is remembered until the owner lets go.
    expect(window.localStorage.getItem("clawbox-chat-size")).toBeNull();

    fireEvent.mouseUp(window);
    expect(JSON.parse(window.localStorage.getItem("clawbox-chat-size") ?? "null")).toEqual({ w: start.width - 80, h: start.height - 160 });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(popup.style.width).toBe(`${start.width - 80}px`);
    expect(popup.style.height).toBe(`${start.height - 160}px`);
    expect(popup.style.left).toBe(`${start.left}px`);
    expect(popup.style.top).toBe(`${start.top}px`);
  });
});

describe("the turn clock", () => {
  it("ticks on the status line without rendering the popup", async () => {
    let release!: (answer: unknown) => void;
    box.chatResponse = () => new Promise((resolve) => { release = resolve; });
    const composer = await mountHermesChat(box);
    // Only the clock's own interval and the clock it reads are faked, and only
    // from here: the mount above needs the real ones.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });

    fireEvent.change(composer, { target: { value: "Count for me" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
    const status = await screen.findByTestId("chat-turn-status");
    await waitFor(() => expect(status.textContent).toMatch(/· 0s$/));
    const renders = counters.popupRenders;

    act(() => { vi.advanceTimersByTime(3000); });

    expect(status.textContent).toMatch(/· 3s$/);
    expect(counters.popupRenders).toBe(renders);

    vi.useRealTimers();
    await act(async () => {
      release({ ok: true, json: async () => ({ text: "1, 2, 3", sessionId: "s1" }) });
    });
    await screen.findByText("1, 2, 3");
  });
});
