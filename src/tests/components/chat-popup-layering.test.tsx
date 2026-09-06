// Where the chat stands among the other desktop surfaces, and where its
// composer's pills stand in the row they share with four 36px buttons.
//
//   - The floating popup was pinned at z 10010 against a window's 100-and-up,
//     so a window opened while the chat was up had its minimize, maximize and
//     close buttons underneath it — the owner had to close the chat to reach
//     the window they had just asked for.
//   - The top-right notice cards are fixed to the same corner the popup floats
//     in. The docked panel already had a way to push them aside; the floating
//     one had none, so a card sat over the chat's +, dock and close buttons
//     until it hid itself 30 s later.
//   - PANEL mode ignored `mobile` entirely: a docked width chosen on a desktop
//     was drawn on a 390px phone at its desktop geometry, off the left edge.
//   - At the docked default width the three pills read "Cla…", "Ma…", "M…".
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup, { noticeColumnInset } from "@/components/ChatPopup";
import { installHermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf-8");

/** What page.tsx draws the notice column at. */
const COLUMN = { width: 320, margin: 16 };
const VIEWPORT = { w: 1440, h: 900 };

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  window.innerWidth = VIEWPORT.w;
  window.innerHeight = VIEWPORT.h;
  // jsdom has no layout engine, so the transcript's auto-scroll has nothing to
  // call. Unrelated to the geometry under test.
  Element.prototype.scrollIntoView = vi.fn();
  installHermesBox();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("the floating chat's place in the stacking order", () => {
  it("takes the layer the desktop gives it instead of standing over every window", async () => {
    render(<ChatPopup isOpen onClose={() => {}} floatingZIndex={137} />);
    const popup = await screen.findByTestId("chat-popup");
    // 137 is a window-band value: the window focused after the chat covers it,
    // which is the whole point — 10010 could not be covered by anything.
    expect(popup.style.zIndex).toBe("137");
    expect(Number(popup.style.zIndex)).toBeLessThan(DESKTOP_LAYERS.chat);
  });

  it("keeps the docked panel above the windows beside it", async () => {
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} floatingZIndex={137} />);
    const popup = await screen.findByTestId("chat-popup");
    // Windows reserve the docked strip rather than overlapping it, so the panel
    // is not part of the focus order and must not drop into the window band.
    await waitFor(() => expect(popup.style.width).toBe("420px"));
    expect(popup.style.zIndex).toBe(String(DESKTOP_LAYERS.chat));
  });

  it("falls back to the chat layer when the desktop names none", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const popup = await screen.findByTestId("chat-popup");
    expect(popup.style.zIndex).toBe(String(DESKTOP_LAYERS.chat));
  });

  it("stays above the phone's full-screen window", async () => {
    render(<ChatPopup isOpen onClose={() => {}} floatingZIndex={137} mobile />);
    const popup = await screen.findByTestId("chat-popup");
    // On a phone both surfaces fill the screen and the window is drawn at
    // z 200 — above the whole window band — so a chat taking its turn in the
    // focus order would be opened and never seen.
    expect(popup.style.zIndex).toBe(String(DESKTOP_LAYERS.chat));
  });

  it("asks to be raised on a press anywhere inside it", async () => {
    const onFocus = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} floatingZIndex={110} onFocus={onFocus} />);
    // The header starts a drag and the composer's controls stop their own
    // pointer events, so the desktop is told on the CAPTURE phase or not at all.
    fireEvent.pointerDown(await screen.findByTestId("chat-header"));
    expect(onFocus).toHaveBeenCalled();

    onFocus.mockClear();
    fireEvent.pointerDown(screen.getByTestId("chat-composer-row"));
    expect(onFocus).toHaveBeenCalled();
  });
});

describe("the notice column's clearance", () => {
  it("is zero while the chat stands clear of the column", () => {
    const left = { left: 40, right: 560 };
    expect(noticeColumnInset(left, VIEWPORT.w, COLUMN.width, COLUMN.margin)).toBe(0);
    expect(noticeColumnInset(null, VIEWPORT.w, COLUMN.width, COLUMN.margin)).toBe(0);
  });

  it("moves the cards left of a chat standing in the corner", () => {
    // A 520px popup at the right gutter: the cards clear its left edge, so the
    // +, dock and close buttons in its header stay uncovered.
    const chat = { left: 912, right: 1432 };
    const inset = noticeColumnInset(chat, VIEWPORT.w, COLUMN.width, COLUMN.margin);
    expect(inset).toBe(VIEWPORT.w - chat.left);
    const columnRight = VIEWPORT.w - (COLUMN.margin + inset);
    expect(columnRight).toBeLessThanOrEqual(chat.left);
  });

  it("never pushes the cards off the screen to do it", () => {
    // A chat all but filling a small desktop: the column moves as far as it
    // can and stays whole, rather than dodging into negative space.
    const narrow = 900;
    const chat = { left: 40, right: 880 };
    const inset = noticeColumnInset(chat, narrow, COLUMN.width, COLUMN.margin);
    expect(narrow - (COLUMN.margin + inset) - COLUMN.width).toBeGreaterThanOrEqual(COLUMN.margin);
  });

  it("reports the floating rect to the desktop, and nothing while docked", async () => {
    const onFloatingRectChange = vi.fn();
    const { rerender } = render(
      <ChatPopup isOpen onClose={() => {}} onFloatingRectChange={onFloatingRectChange} />,
    );
    await screen.findByTestId("chat-popup");
    await waitFor(() => expect(onFloatingRectChange).toHaveBeenCalled());
    expect(onFloatingRectChange.mock.calls.at(-1)?.[0]).toMatchObject({ left: expect.any(Number) });

    onFloatingRectChange.mockClear();
    rerender(
      <ChatPopup
        isOpen
        onClose={() => {}}
        initialPanelWidth={420}
        onFloatingRectChange={onFloatingRectChange}
      />,
    );
    // Docked, the desktop uses the strip it already reserves; a stale floating
    // rect would move the cards for a popup that is no longer there.
    await waitFor(() => expect(onFloatingRectChange).toHaveBeenLastCalledWith(null));
  });
});

describe("a docked chat on a phone", () => {
  it("is drawn full-screen instead of at its desktop geometry", async () => {
    render(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={765} mobile />);
    const popup = await screen.findByTestId("chat-popup");
    // The panel is a right-anchored column: at 765px on a 390px screen it was
    // drawn at x=-381, with the header and every way back off the left edge.
    expect(popup.style.left).toBe("0px");
    expect(popup.style.right).toBe("0px");
    expect(popup.style.top).toBe("0px");
    expect(popup.style.bottom).toBe("0px");
    expect(popup.style.width).not.toBe("765px");
  });

  it("keeps the width, so widening the window docks it again", async () => {
    const { rerender } = render(
      <ChatPopup isOpen onClose={() => {}} initialPanelWidth={765} mobile />,
    );
    await screen.findByTestId("chat-popup");
    rerender(<ChatPopup isOpen onClose={() => {}} initialPanelWidth={765} mobile={false} />);
    await waitFor(() => expect(screen.getByTestId("chat-popup").style.width).toBe("765px"));
  });

  it("does not hand the desktop a strip to reserve while it is a phone", async () => {
    const onPanelModeChange = vi.fn();
    // Docked, then closed on a desktop: the width is remembered for the reopen.
    const { rerender } = render(
      <ChatPopup isOpen onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />,
    );
    await waitFor(() => expect(screen.getByTestId("chat-popup").style.width).toBe("420px"));
    rerender(
      <ChatPopup isOpen={false} onClose={() => {}} initialPanelWidth={420} onPanelModeChange={onPanelModeChange} />,
    );
    await waitFor(() => expect(onPanelModeChange).toHaveBeenLastCalledWith(0));

    // Reopened at phone width: full-screen, and the desktop is not told to keep
    // a 426px strip clear on a 390px screen.
    onPanelModeChange.mockClear();
    rerender(
      <ChatPopup isOpen onClose={() => {}} initialPanelWidth={0} mobile onPanelModeChange={onPanelModeChange} />,
    );
    await screen.findByTestId("chat-popup");
    expect(onPanelModeChange).not.toHaveBeenCalledWith(420);

    // Back on a desktop, the layout the owner chose is still theirs.
    rerender(
      <ChatPopup isOpen onClose={() => {}} initialPanelWidth={0} mobile={false} onPanelModeChange={onPanelModeChange} />,
    );
    await waitFor(() => expect(onPanelModeChange).toHaveBeenLastCalledWith(420));
  });
});

describe("the composer's pill row", () => {
  it("is laid out by the stylesheet, not by an inline style it cannot express", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const row = await screen.findByTestId("chat-composer-row");
    expect(row.className).toContain("chat-composer-row");
  });

  it("lets the pills take a line of their own before their labels truncate", () => {
    const row = css.match(/\.chat-composer-row\s*\{[^}]*\}/)?.[0] ?? "";
    // Without the wrap the pills share the line with four 36px buttons: 216px
    // for three of them at the 420px docked default, which read "Cla…", "Ma…",
    // "M…" — a pill that names neither the provider nor the model.
    expect(row).toMatch(/flex-wrap:\s*wrap/);

    const pills = css.match(/\.chat-header-pills\s*\{[^}]*\}/)?.[0] ?? "";
    // The basis is what decides WHEN the row breaks; `flex: 1 1 auto` never
    // breaks it, because auto shrinks to nothing first.
    const basis = pills.match(/flex:\s*1\s+1\s+(\d+)px/)?.[1];
    expect(Number(basis)).toBeGreaterThanOrEqual(260);
    // …and a threshold only: on the line it lands on it may still shrink,
    // rather than pushing the send button off a 340px chat.
    expect(pills).toMatch(/min-width:\s*0/);
  });
});
