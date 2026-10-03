// What the UI sweep found around the floating chat itself.
//
//   - Escape closed the WHOLE chat while a composer menu or the "Create app"
//     card was open, instead of the innermost surface. On a docked panel that
//     also dropped the dock, so one keystroke cost the owner their layout.
//   - Closing a DOCKED chat with X forgot the dock: the next open was a
//     520x680 floating popup.
//   - Resize and drag were floored at the minimum size but never capped at the
//     viewport, so the popup could be grown or dragged past the screen edge
//     with its header buttons and composer outside it.
//
// And what the sweep of 2026-09-07 found once those were in:
//
//   - The Escape guard held in jsdom and not in a browser, which flushes the
//     card's close between the card's listener and the chat's.
//   - The composer kept its grown height after a multi-line message was sent.
//   - Undock then Dock to right docked at the default width, not the owner's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { installHermesBox, mountHermesChat } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule, and says there why 5 s is the wrong budget here and 30 s still
// fails a test that has genuinely hung.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


const VIEWPORT = { w: 1440, h: 900 };
/** The gutter the popup keeps from every edge; mirrored from the component. */
const MARGIN = 8;
/** Where the popup stands for the geometry cases, and how big it is. */
const POPUP = { left: 300, top: 200, width: 520, height: 680 };

function stubPopupRect(el: HTMLElement) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: POPUP.left, y: POPUP.top,
    left: POPUP.left, top: POPUP.top,
    right: POPUP.left + POPUP.width, bottom: POPUP.top + POPUP.height,
    width: POPUP.width, height: POPUP.height,
    toJSON: () => ({}),
  } as DOMRect);
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  window.innerWidth = VIEWPORT.w;
  window.innerHeight = VIEWPORT.h;
  // jsdom has no layout engine, so the transcript's auto-scroll has nothing to
  // call. Unrelated to anything under test here.
  Element.prototype.scrollIntoView = vi.fn();
  installHermesBox();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("Escape inside the chat", () => {
  it("closes an open composer menu and leaves the conversation up", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    // Its own budget: the pill waits on the gateway handshake and the model
    // seed, ~0.7 s idle and several times that under a full parallel run,
    // where the shared 5 s (src/tests/setup.ts) was seen to run out.
    const pill = await screen.findByRole("button", { name: /^Chat provider:/ }, { timeout: 10_000 });
    fireEvent.click(pill);
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-popup")).toBeTruthy();
  });

  it("closes the Create app card and leaves the conversation up", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("chat-new-app-toggle"));
    await screen.findByTestId("chat-new-app");

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("chat-new-app")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the Create app card when the browser flushes its close before the key reaches the window", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("chat-new-app-toggle"));
    await screen.findByTestId("chat-new-app");
    // A browser runs a microtask checkpoint after each listener, and React
    // flushes the card's close in it — so by the time the key reaches the
    // window, the chat's listener has been re-registered with the card gone.
    // jsdom runs no checkpoint between listeners; this listener, registered
    // after the card's so it runs after it, stands in for that flush.
    const flushBetweenListeners = () => flushSync(() => {});
    document.addEventListener("keydown", flushBetweenListeners);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", flushBetweenListeners);
    }

    await waitFor(() => expect(screen.queryByTestId("chat-new-app")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  // The CI flake behind the case above. "+" opens the card after a status
  // fetch, outside any event, and on a loaded box React's scheduler runs out of
  // its 5 ms slice at the commit, so a PASSIVE effect from that render runs a
  // task later. An Escape pressed at the card already on screen then found no
  // card listener, and only the chat's own. Making every task overrun its slice
  // reproduces that every time; the card's listeners go on in its commit now.
  it("closes the Create app card on an Escape pressed the moment it appears, on a busy box", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    const toggle = await screen.findByTestId("chat-new-app-toggle");
    const realNow = performance.now.bind(performance);
    let overrun = 0;
    const busy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + (overrun += 50));
    try {
      fireEvent.click(toggle);
      await screen.findByTestId("chat-new-app");
    } finally {
      busy.mockRestore();
    }

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("chat-new-app")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes the chat when nothing is open on top of it", async () => {
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);
    await screen.findByRole("textbox");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("closing a docked chat", () => {
  it("gives the desktop its strip back and comes back docked", async () => {
    const onPanelModeChange = vi.fn();
    const { rerender } = render(
      <ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />,
    );
    await waitFor(() => expect(screen.getByTestId("chat-popup").style.width).toBe("420px"));

    // The X. The desktop un-reserves the strip and hands the width back as 0,
    // which is what used to erase the dock.
    rerender(
      <ChatPopup isOpen={false} onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />,
    );
    expect(onPanelModeChange).toHaveBeenLastCalledWith(0);
    rerender(
      <ChatPopup isOpen={false} onClose={() => {}} initialPanelWidth={0} onPanelModeChange={onPanelModeChange} />,
    );

    // Open it again: the mascot, the shelf button, the desktop icon.
    rerender(
      <ChatPopup isOpen onClose={() => {}} initialPanelWidth={0} onPanelModeChange={onPanelModeChange} />,
    );
    await waitFor(() => expect(onPanelModeChange).toHaveBeenLastCalledWith(420));
    // Not the 520x680 floating popup the owner kept being handed.
    expect(screen.getByTestId("chat-popup").style.width).toBe("420px");
  });
});

describe("the composer after a send", () => {
  it("shrinks back to one row instead of keeping the height the message grew it to", async () => {
    const box = installHermesBox();
    const textarea = await mountHermesChat(box);
    // Three lines' worth, the way the textarea's own onInput measures it.
    Object.defineProperty(textarea, "scrollHeight", { value: 70, configurable: true });
    fireEvent.input(textarea);
    expect(textarea.style.height).toBe("70px");

    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(""));
    // `auto` is the one-row height (`rows={1}`); the box used to sit at 70px
    // with only the placeholder in it until the next keystroke.
    expect(textarea.style.height).toBe("auto");
  });
});

describe("a draft put back without a keystroke", () => {
  it("grows the composer to fit it, the way a keystroke would", async () => {
    const box = installHermesBox();
    const textarea = await mountHermesChat(box);
    Object.defineProperty(textarea, "scrollHeight", { value: 70, configurable: true });
    // `change` reaches React's onChange and never the textarea's onInput —
    // the shape of a tab switch putting a stashed draft back with setInput
    // alone. Shrinking on a send while leaving this at one row would have
    // traded the sweep's defect for a three-line draft behind a scrollbar.
    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });
    await waitFor(() => expect(textarea.style.height).toBe("70px"));
  });
});

describe("undocking and docking again", () => {
  it("docks back at the width the owner had, not the default", async () => {
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={858} onPanelModeChange={onPanelModeChange} />);
    await waitFor(() => expect(screen.getByTestId("chat-popup").style.width).toBe("858px"));

    fireEvent.click(screen.getByTitle("Undock panel"));
    expect(onPanelModeChange).toHaveBeenLastCalledWith(0);

    fireEvent.click(screen.getByTitle("Dock to right"));
    // 420 — the default — is what a brief undock used to cost a resized panel,
    // and what the desktop then persisted.
    expect(onPanelModeChange).toHaveBeenLastCalledWith(858);
    expect(screen.getByTestId("chat-popup").style.width).toBe("858px");
  });
});

describe("the floating chat's geometry", () => {
  it("stops resizing at the screen edge instead of pushing its own controls off", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    stubPopupRect(popup);

    const corner = popup.querySelector(".cursor-se-resize") as HTMLElement;
    fireEvent.mouseDown(corner, { clientX: POPUP.left + POPUP.width, clientY: POPUP.top + POPUP.height });
    fireEvent.mouseMove(window, { clientX: 2400, clientY: 1800 });

    // The popup's own gutter, not the pointer's position: the send button and
    // the header's dock/close buttons stay on screen.
    expect(popup.style.width).toBe(`${VIEWPORT.w - POPUP.left - MARGIN}px`);
    expect(popup.style.height).toBe(`${VIEWPORT.h - POPUP.top - MARGIN}px`);
    fireEvent.mouseUp(window);
  });

  it("stops dragging at the screen edge instead of parking the composer below it", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    stubPopupRect(popup);

    const header = screen.getByTestId("chat-header");
    fireEvent.pointerDown(header, { clientX: 400, clientY: 220 });
    fireEvent.pointerMove(window, { clientX: 2000, clientY: 1600 });

    expect(popup.style.left).toBe(`${VIEWPORT.w - POPUP.width - MARGIN}px`);
    expect(popup.style.top).toBe(`${VIEWPORT.h - POPUP.height - MARGIN}px`);
    fireEvent.pointerUp(window, { clientX: 2000, clientY: 1600 });
  });
});

// The popup hanging above the mascot works its `left` out from the window's
// width. It used to be kept current by the desktop re-rendering it — every
// 100 px of a resize, every poll, the shelf clock — and stopped being once the
// chat was memoised: a window narrowed from 1920 to 1280 px left it at the old
// `left`, off the screen, until the mascot was tapped again.
describe("the floating chat when the window changes size", () => {
  const SIZE = { w: 520, h: 680 };
  /** Where it hangs over a mascot at 85% of `vw`: centred on it, inside the 8px gutter. */
  const anchoredLeft = (vw: number) => Math.max(MARGIN, Math.min(0.85 * vw - SIZE.w / 2, vw - SIZE.w - MARGIN));

  function resizeTo(w: number, h: number) {
    act(() => {
      window.innerWidth = w;
      window.innerHeight = h;
      window.dispatchEvent(new Event("resize"));
    });
  }

  /**
   * Open, connected and quiet: nothing of the mount is still arriving, so a
   * render after this is one the resize itself caused. (A resize also has the
   * kiosk-bar hook set the inset it already holds, which can make React call
   * the popup once to find nothing moved — a render it then throws away, so
   * it moves nothing.)
   */
  async function mountSettled(ui: ReactElement) {
    render(ui);
    const popup = await screen.findByTestId("chat-popup");
    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    await waitFor(() => expect(popup.style.opacity).toBe("1"));
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    return popup;
  }

  /** jsdom has no layout: the rect follows the inline style, the way a browser's would. */
  function followStyleRect(el: HTMLElement) {
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => {
      const left = Number.parseFloat(el.style.left) || 0;
      const top = 200;
      return {
        x: left, y: top, left, top, right: left + SIZE.w, bottom: top + SIZE.h,
        width: SIZE.w, height: SIZE.h, toJSON: () => ({}),
      } as DOMRect;
    });
  }

  it("moves with the mascot's place when the window is narrowed, and back when it is widened", async () => {
    resizeTo(1920, 1080);
    const popup = await mountSettled(<ChatPopup isOpen onClose={() => {}} mascotX={85} />);
    expect(popup.style.left).toBe(`${anchoredLeft(1920)}px`);

    resizeTo(1280, 800);
    // 1372 px on a 1280 px window would be entirely off the screen.
    expect(popup.style.left).toBe(`${anchoredLeft(1280)}px`);

    resizeTo(1920, 1080);
    expect(popup.style.left).toBe(`${anchoredLeft(1920)}px`);
  });

  it("tells the desktop where it moved to, so its notices dodge the new place", async () => {
    resizeTo(1920, 1080);
    const onFloatingRectChange = vi.fn();
    const popup = await mountSettled(<ChatPopup isOpen onClose={() => {}} mascotX={85} onFloatingRectChange={onFloatingRectChange} />);
    followStyleRect(popup);

    resizeTo(1280, 800);
    expect(onFloatingRectChange).toHaveBeenLastCalledWith(expect.objectContaining({ left: anchoredLeft(1280) }));
  });

  it("stays where the owner put it once it has been dragged", async () => {
    resizeTo(1440, 900);
    const popup = await mountSettled(<ChatPopup isOpen onClose={() => {}} mascotX={85} />);
    stubPopupRect(popup);
    fireEvent.pointerDown(screen.getByTestId("chat-header"), { clientX: 400, clientY: 220 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 200 });
    expect(popup.style.left).toBe(`${POPUP.left - 100}px`);

    resizeTo(1280, 800);
    expect(popup.style.left).toBe(`${POPUP.left - 100}px`);
  });
});

// A gesture the browser or the OS CANCELS — it took the touch for itself: an
// edge swipe, a palm, a call coming in. The chat's drag and both resizes move
// the popup straight on the DOM and commit to state once, at the end, and
// handled only the release: a cancel left the DOM moved, the state stale and
// the move listeners armed, so the next touch anywhere on the screen went on
// dragging or resizing the chat.
describe("a gesture the system cancels", () => {
  function resizeTo(w: number, h: number) {
    act(() => {
      window.innerWidth = w;
      window.innerHeight = h;
      window.dispatchEvent(new Event("resize"));
    });
  }

  /** Dragged from (400, 220) on the header to the left edge, where a drop would snap. */
  async function dragToTheLeftEdge() {
    render(<ChatPopup isOpen onClose={() => {}} mascotX={85} />);
    const popup = await screen.findByTestId("chat-popup");
    stubPopupRect(popup);
    fireEvent.pointerDown(screen.getByTestId("chat-header"), { clientX: 400, clientY: 220 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 220 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 220 });
    // 300 + (2 - 400) is off the screen: held at the gutter.
    expect(popup.style.left).toBe(`${MARGIN}px`);
    expect(popup.style.top).toBe(`${POPUP.top}px`);
    expect(screen.getByTestId("snap-preview")).toBeTruthy();
    return popup;
  }

  it("ends a drag where the chat stands, snaps nothing, and leaves the next touch alone", async () => {
    const popup = await dragToTheLeftEdge();

    fireEvent.pointerCancel(window, { clientX: 2, clientY: 220 });

    // No snap: the plate is gone and the chat is not laid over the left half.
    expect(screen.queryByTestId("snap-preview")).toBeNull();
    expect(popup.style.width).toBe(`${POPUP.width}px`);
    expect(popup.style.left).toBe(`${MARGIN}px`);
    expect(popup.style.top).toBe(`${POPUP.top}px`);
    // The gesture is over: the next move anywhere drags nothing.
    fireEvent.pointerMove(window, { clientX: 700, clientY: 400 });
    expect(popup.style.left).toBe(`${MARGIN}px`);
    expect(popup.style.top).toBe(`${POPUP.top}px`);
  });

  it("keeps the place it was cancelled at when the window then changes size — all of it, not the mascot's left over the drag's top", async () => {
    const popup = await dragToTheLeftEdge();
    fireEvent.pointerCancel(window, { clientX: 2, clientY: 220 });

    // An un-placed chat is re-hung over the mascot on a resize; a cancelled
    // drag left one moved on screen and un-placed in state, and the resize
    // wrote the mascot's `left` beside the drag's `top`.
    resizeTo(1280, 800);
    expect(popup.style.left).toBe(`${MARGIN}px`);
    expect(popup.style.top).toBe(`${POPUP.top}px`);
    expect(popup.style.bottom).toBe("auto");
  });

  it("ends a resize at the size on screen, remembers it, and leaves the next touch alone", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    stubPopupRect(popup);
    const corner = popup.querySelector(".cursor-se-resize") as HTMLElement;
    const at = { x: POPUP.left + POPUP.width, y: POPUP.top + POPUP.height };

    fireEvent.touchStart(corner, { touches: [{ clientX: at.x, clientY: at.y }] });
    fireEvent.touchMove(window, { touches: [{ clientX: at.x - 60, clientY: at.y - 100 }] });
    expect(popup.style.width).toBe(`${POPUP.width - 60}px`);
    expect(popup.style.height).toBe(`${POPUP.height - 100}px`);

    fireEvent.touchCancel(window, { changedTouches: [{ clientX: at.x - 60, clientY: at.y - 100 }] });

    // Committed as a release would: the size the next reload opens at.
    expect(JSON.parse(window.localStorage.getItem("clawbox-chat-size") ?? "null"))
      .toEqual({ w: POPUP.width - 60, h: POPUP.height - 100 });
    // The gesture is over: the next touch resizes nothing.
    fireEvent.touchMove(window, { touches: [{ clientX: at.x - 160, clientY: at.y - 200 }] });
    expect(popup.style.width).toBe(`${POPUP.width - 60}px`);
    expect(popup.style.height).toBe(`${POPUP.height - 100}px`);
  });

  it("ends a docked panel's resize at the width on screen, tells the desktop, and leaves the next touch alone", async () => {
    const onPanelModeChange = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />);
    const popup = await screen.findByTestId("chat-popup");
    await waitFor(() => expect(popup.style.width).toBe("420px"));
    vi.spyOn(popup, "getBoundingClientRect").mockReturnValue({
      x: 1000, y: 12, left: 1000, top: 12, right: 1420, bottom: 830, width: 420, height: 818, toJSON: () => ({}),
    } as DOMRect);
    const edge = popup.querySelector(".cursor-ew-resize") as HTMLElement;

    fireEvent.touchStart(edge, { touches: [{ clientX: 1000, clientY: 400 }] });
    fireEvent.touchMove(window, { touches: [{ clientX: 900, clientY: 400 }] });
    expect(popup.style.width).toBe("520px");
    onPanelModeChange.mockClear();

    fireEvent.touchCancel(window, { changedTouches: [{ clientX: 900, clientY: 400 }] });

    // The strip the desktop reserves beside the panel follows the panel.
    expect(onPanelModeChange).toHaveBeenLastCalledWith(520);
    // The gesture is over: the next touch resizes nothing.
    fireEvent.touchMove(window, { touches: [{ clientX: 700, clientY: 400 }] });
    expect(popup.style.width).toBe("520px");
  });
});
