/**
 * The chat transcript follows content that grows — a streaming reply, tool
 * pills, the coding-agent card polling in, approval cards, pictures loading
 * late — but only while the reader is at the bottom (use-stick-to-bottom.ts),
 * and it is the ONLY thing that scrolls the transcript (TASK-2222).
 *
 * The geometry here behaves like a browser's: the scroll position is clamped
 * to the content, and the content's height is whatever the test says it is.
 */
import fs from "node:fs";
import path from "node:path";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import {
  AT_BOTTOM_PX,
  HANDS_ON_MS,
  isNearBottom,
  STICK_THRESHOLD_PX,
  useStickToBottom,
} from "@/lib/use-stick-to-bottom";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.add(el); }
  /** Tracked, because a transcript replaced wholesale must not be held by the observer. */
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  fire() { this.callback([], this as unknown as ResizeObserver); }
}

let scrollToBottomOf: (() => void) | null = null;

function Transcript({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  scrollToBottomOf = useStickToBottom(ref, enabled);
  return (
    <div ref={ref} data-testid="transcript">
      <div data-testid="first">hello</div>
    </div>
  );
}

const CLIENT = 300;

/**
 * Give the element the geometry jsdom does not compute, the way a browser
 * keeps it: the position never goes past the content's end.
 */
function geometry(el: HTMLElement, state: { height: number }) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => CLIENT });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, state.height - CLIENT)); },
  });
}

const bottomOf = (state: { height: number }) => state.height - CLIENT;

/** The browser moved the transcript (the reader, or a clamp) and says so. */
function scrolled(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

/** A real wheel gesture: the wheel event first, then the scroll it causes. */
function wheel(el: HTMLElement, deltaY: number) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  scrolled(el, el.scrollTop + deltaY);
}

/** The content grew below the fold — a streamed chunk, a card. */
function grow(state: { height: number }, by: number) {
  state.height += by;
  FakeResizeObserver.instances[0].fire();
}

let clock = 0;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  scrollToBottomOf = null;
  clock = 1_000;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A transcript at its bottom, 900 px tall: the start of every reading scenario. */
function readingAtBottom() {
  render(<Transcript />);
  const el = screen.getByTestId("transcript");
  const state = { height: 900 };
  geometry(el, state);
  grow(state, 0);
  expect(el.scrollTop).toBe(bottomOf(state));
  return { el, state };
}

describe("isNearBottom", () => {
  it("counts the bottom and anything within the threshold, and nothing above it", () => {
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 - STICK_THRESHOLD_PX })).toBe(true);
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 - STICK_THRESHOLD_PX - 1 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 - AT_BOTTOM_PX }, AT_BOTTOM_PX)).toBe(true);
  });
});

describe("useStickToBottom: following", () => {
  it("follows a card that grows in place while the reader is at the bottom", () => {
    render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const state = { height: 300 };
    geometry(el, state);
    // The card below the last message grew: no message changed, the size did.
    grow(state, 600);
    expect(el.scrollTop).toBe(600);
  });

  it("follows a reply streaming in, chunk after chunk", () => {
    const { el, state } = readingAtBottom();
    for (let i = 0; i < 5; i++) {
      grow(state, 40);
      expect(el.scrollTop).toBe(bottomOf(state));
    }
  });

  it("follows nodes added to the transcript, and watches the new child's size from then on", async () => {
    render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const state = { height: 300 };
    geometry(el, state);
    const card = document.createElement("div");
    state.height = 1000;
    el.appendChild(card);
    await waitFor(() => expect(el.scrollTop).toBe(700));
    expect(FakeResizeObserver.instances[0].observed.has(card)).toBe(true);
  });

  it("follows text streamed into a bubble that is already there", async () => {
    const { el, state } = readingAtBottom();
    const text = screen.getByTestId("first").firstChild as Text;
    state.height = 1400;
    text.data = "hello, and a great deal more";
    await waitFor(() => expect(el.scrollTop).toBe(bottomOf(state)));
  });
});

describe("useStickToBottom: a reader who scrolls up while the bot writes", () => {
  it("is left where they are by every chunk, however little they scrolled", () => {
    const { el, state } = readingAtBottom();
    // One trackpad nudge, far inside the old 80 px "still at the bottom" band:
    // the next chunk used to land first and put them back.
    wheel(el, -20);
    const readingAt = el.scrollTop;
    expect(bottomOf(state) - readingAt).toBeLessThan(STICK_THRESHOLD_PX);
    clock += HANDS_ON_MS * 10;
    for (let i = 0; i < 20; i++) grow(state, 30);
    expect(el.scrollTop).toBe(readingAt);
  });

  it("is left where they are by a scroll they make with the scrollbar or the keys", () => {
    const { el, state } = readingAtBottom();
    // No wheel event at all: the position moving up is the reader's.
    scrolled(el, el.scrollTop - 250);
    const readingAt = el.scrollTop;
    for (let i = 0; i < 10; i++) grow(state, 50);
    expect(el.scrollTop).toBe(readingAt);
  });

  it("writes nothing while the wheel is still turning, even before the scroll lands", () => {
    const { el, state } = readingAtBottom();
    const start = el.scrollTop;
    // The wheel event arrives; the browser's smooth scroll has not moved yet
    // when the next chunk comes in. A write now would cancel the scroll.
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    grow(state, 40);
    expect(el.scrollTop).toBe(start);
    // The scroll lands: up, so the reader has let go of the bottom.
    scrolled(el, start - 60);
    clock += HANDS_ON_MS * 2;
    grow(state, 40);
    expect(el.scrollTop).toBe(start - 60);
  });

  it("writes nothing while a finger is on the transcript, and follows on release if still at the bottom", () => {
    const { el, state } = readingAtBottom();
    const start = el.scrollTop;
    el.dispatchEvent(new Event("touchstart"));
    grow(state, 40);
    expect(el.scrollTop).toBe(start);
    // A tap, not a drag: the reader never left the bottom.
    const end = new Event("touchend") as TouchEvent;
    Object.defineProperty(end, "touches", { value: [] });
    clock += HANDS_ON_MS * 2;
    el.dispatchEvent(end);
    expect(el.scrollTop).toBe(bottomOf(state));
  });

  it("writes nothing while the scrollbar is held", () => {
    const { el, state } = readingAtBottom();
    const start = el.scrollTop;
    el.dispatchEvent(new Event("pointerdown"));
    grow(state, 40);
    expect(el.scrollTop).toBe(start);
    window.dispatchEvent(new Event("pointerup"));
    expect(el.scrollTop).toBe(bottomOf(state));
  });

  it("follows a wheel's growth once the wheel has stopped, when the reader stayed at the bottom", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { el, state } = readingAtBottom();
    const start = el.scrollTop;
    // Wheeling DOWN at the bottom: nothing to scroll, still pinned.
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    grow(state, 40);
    expect(el.scrollTop).toBe(start);
    clock += HANDS_ON_MS + 20;
    vi.advanceTimersByTime(HANDS_ON_MS + 20);
    expect(el.scrollTop).toBe(bottomOf(state));
  });

  it("keeps following when the content shrinks and the browser clamps the position", () => {
    const { el, state } = readingAtBottom();
    // A card collapsed: the position moved UP, but the reader did not.
    state.height -= 200;
    scrolled(el, el.scrollTop);
    grow(state, 50);
    expect(el.scrollTop).toBe(bottomOf(state));
  });
});

describe("useStickToBottom: back at the bottom", () => {
  it("follows again once the reader is back at the very bottom", () => {
    const { el, state } = readingAtBottom();
    wheel(el, -400);
    clock += HANDS_ON_MS * 2;
    grow(state, 100);
    expect(bottomOf(state) - el.scrollTop).toBe(500);

    // Back down, all the way.
    scrolled(el, bottomOf(state));
    clock += HANDS_ON_MS * 2;
    grow(state, 100);
    expect(el.scrollTop).toBe(bottomOf(state));
    grow(state, 100);
    expect(el.scrollTop).toBe(bottomOf(state));
  });

  it("catches a reader scrolling DOWN to within the threshold, not one parked there", () => {
    const { el, state } = readingAtBottom();
    // Parked 40 px up after scrolling UP: left alone.
    wheel(el, -40);
    clock += HANDS_ON_MS * 2;
    grow(state, 30);
    expect(bottomOf(state) - el.scrollTop).toBe(70);

    // Wheeling down and ending within the threshold: followed.
    wheel(el, 20);
    expect(bottomOf(state) - el.scrollTop).toBeLessThanOrEqual(STICK_THRESHOLD_PX);
    clock += HANDS_ON_MS * 2;
    grow(state, 30);
    expect(el.scrollTop).toBe(bottomOf(state));
  });

  it("does not take a downward nudge it did not see the reader make as a return", () => {
    const { el, state } = readingAtBottom();
    wheel(el, -300);
    clock += HANDS_ON_MS * 2;
    // Something above re-laid out and the browser's scroll anchoring moved the
    // position down a little: no wheel, no key, no finger.
    scrolled(el, el.scrollTop + 250);
    grow(state, 30);
    expect(bottomOf(state) - el.scrollTop).toBe(80);
  });

  it("re-pins when the caller asks — the owner's own send", () => {
    const { el, state } = readingAtBottom();
    wheel(el, -400);
    clock += HANDS_ON_MS * 2;
    grow(state, 100);
    expect(el.scrollTop).not.toBe(bottomOf(state));

    act(() => scrollToBottomOf?.());
    expect(el.scrollTop).toBe(bottomOf(state));
    grow(state, 100);
    expect(el.scrollTop).toBe(bottomOf(state));
  });

  it("follows a conversation short enough to fit, whatever the reader did before", () => {
    const { el, state } = readingAtBottom();
    wheel(el, -400);
    clock += HANDS_ON_MS * 2;
    // Cleared: the content fits, there is no position to keep.
    state.height = 200;
    scrolled(el, 0);
    grow(state, 50);
    // Grows past the fold: followed from its first line.
    grow(state, 400);
    expect(el.scrollTop).toBe(bottomOf(state));
  });
});

describe("useStickToBottom: observers", () => {
  it("observes the transcript and every child, so a late-loading picture counts", () => {
    render(<Transcript />);
    const observer = FakeResizeObserver.instances[0];
    expect(observer.observed.has(screen.getByTestId("transcript"))).toBe(true);
    expect(observer.observed.has(screen.getByTestId("first"))).toBe(true);
  });

  it("lets go of a child that leaves, and picks up the one that arrives", async () => {
    render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const observer = FakeResizeObserver.instances[0];
    const first = screen.getByTestId("first");
    expect(observer.observed.has(first)).toBe(true);

    // A session switch replaces the transcript: the old bubbles go, new ones
    // arrive. The observer must follow both halves of that.
    const card = document.createElement("div");
    el.appendChild(card);
    await waitFor(() => expect(observer.observed.has(card)).toBe(true));
    first.remove();
    await waitFor(() => expect(observer.observed.has(first)).toBe(false));
    expect(observer.observed.has(card)).toBe(true);
    expect(observer.observed.has(el)).toBe(true);
  });

  it("attaches nothing while the transcript is not on screen", () => {
    render(<Transcript enabled={false} />);
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });

  it("disconnects its observers and listeners when the transcript goes away", () => {
    const { unmount } = render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const observer = FakeResizeObserver.instances[0];
    const removed = vi.spyOn(el, "removeEventListener");
    unmount();
    expect(observer.observed.size).toBe(0);
    expect(removed.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["scroll", "wheel", "keydown", "touchstart", "touchend", "pointerdown"]),
    );
  });
});

describe("both chats", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), "src/components", file), "utf8");

  it("wire their messages area to the hook — the full page always on", () => {
    const source = read("ChatApp.tsx");
    expect(source).toContain("useStickToBottom(transcriptRef, true)");
    expect(source).toMatch(/\{\/\* Messages area \*\/\}\s*<div ref=\{transcriptRef\}/);
  });

  it("wire the transcript they render to the hook — the mascot chat while it is shown", () => {
    const source = read("ChatPopup.tsx");
    expect(source).toContain("useStickToBottom(transcriptRef, visible)");
    const transcript = source.slice(source.indexOf("ref={transcriptRef}"), source.indexOf('data-testid="chat-transcript"'));
    // The ref sits on the element that carries the transcript's test id.
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript.length).toBeLessThan(200);
  });

  it("scroll the transcript through nothing else: no sentinel scrolled into view on a change of state", () => {
    for (const file of ["ChatApp.tsx", "ChatPopup.tsx"]) {
      const source = read(file);
      expect(source, file).not.toContain("scrollIntoView");
      expect(source, file).not.toContain("messagesEndRef");
    }
  });
});
