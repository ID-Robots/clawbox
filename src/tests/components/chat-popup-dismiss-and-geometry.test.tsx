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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { installHermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

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
    const pill = await screen.findByRole("button", { name: /^Chat provider:/ });
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
