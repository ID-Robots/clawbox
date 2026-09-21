/**
 * The mascot chat follows content that grows without a new message — tool
 * pills, the coding-agent card polling in, approval cards, pictures loading
 * late — but only while the reader is at the bottom (use-stick-to-bottom.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { isNearBottom, STICK_THRESHOLD_PX, useStickToBottom } from "@/lib/use-stick-to-bottom";

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

function Transcript({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useStickToBottom(ref, enabled);
  return (
    <div ref={ref} data-testid="transcript">
      <div data-testid="first">hello</div>
    </div>
  );
}

/** Give the element the geometry jsdom does not compute. */
function geometry(el: HTMLElement, state: { height: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
});
afterEach(() => vi.unstubAllGlobals());

describe("isNearBottom", () => {
  it("counts the bottom and anything within the threshold, and nothing above it", () => {
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 - STICK_THRESHOLD_PX })).toBe(true);
    expect(isNearBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 600 - STICK_THRESHOLD_PX - 1 })).toBe(false);
  });
});

describe("useStickToBottom", () => {
  it("follows a card that grows in place while the reader is at the bottom", () => {
    render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const state = { height: 300 };
    geometry(el, state);
    // The card below the last message grew: no message changed, the size did.
    state.height = 900;
    FakeResizeObserver.instances[0].fire();
    expect(el.scrollTop).toBe(900);
  });

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

  it("leaves a reader who scrolled up where they are, and follows again once they are back down", () => {
    render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const state = { height: 900 };
    geometry(el, state);

    scrollTo(el, 100);
    state.height = 1200;
    FakeResizeObserver.instances[0].fire();
    expect(el.scrollTop).toBe(100);

    scrollTo(el, 900);
    state.height = 1500;
    FakeResizeObserver.instances[0].fire();
    expect(el.scrollTop).toBe(1500);
  });

  it("follows nodes added to the transcript, and watches the new child's size from then on", async () => {
    render(<Transcript />);
    const el = screen.getByTestId("transcript");
    const state = { height: 300 };
    geometry(el, state);
    const card = document.createElement("div");
    state.height = 1000;
    el.appendChild(card);
    await waitFor(() => expect(el.scrollTop).toBe(1000));
    expect(FakeResizeObserver.instances[0].observed.has(card)).toBe(true);
  });

  it("attaches nothing while the transcript is not on screen", () => {
    render(<Transcript enabled={false} />);
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });

  it("disconnects its observers when the transcript goes away", () => {
    const { unmount } = render(<Transcript />);
    const observer = FakeResizeObserver.instances[0];
    unmount();
    expect(observer.observed.size).toBe(0);
  });
});

describe("the full-page chat", () => {
  it("wires its messages area to the hook, always on", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/ChatApp.tsx"), "utf8");
    expect(source).toContain("useStickToBottom(transcriptRef, true)");
    expect(source).toMatch(/\{\/\* Messages area \*\/\}\s*<div ref=\{transcriptRef\}/);
  });
});

describe("the mascot chat", () => {
  it("wires the transcript it renders to the hook", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/ChatPopup.tsx"), "utf8");
    expect(source).toContain("useStickToBottom(transcriptRef, visible)");
    const transcript = source.slice(source.indexOf("ref={transcriptRef}"), source.indexOf('data-testid="chat-transcript"'));
    // The ref sits on the element that carries the transcript's test id.
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript.length).toBeLessThan(200);
  });
});
