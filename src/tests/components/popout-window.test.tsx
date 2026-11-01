/**
 * PopoutWindow (src/components/PopoutWindow.tsx): the desktop window an app or
 * the chat opens beside itself — a run's whole goal, the Create planner.
 *
 * Pinned: it is the desktop's own window (ChromeWindow) with no Minimize; it
 * stands in front of the app windows and the chat; the one pressed last is in
 * front; Escape closes the FRONT one only — when focus is in it or nowhere —
 * stops there so the chat's own Escape never sees it, hands focus back, and
 * leaves a key the content already handled alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import PopoutWindow from "@/components/PopoutWindow";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

afterEach(() => { vi.restoreAllMocks(); });

const zOf = (appId: string) => Number(screen.getByTestId(`chrome-window-${appId}`).style.zIndex);

describe("PopoutWindow", () => {
  it("is a desktop window without a Minimize, in front of the app windows and the chat", () => {
    render(<PopoutWindow title="Task · Fix it" appId="one" onClose={() => {}}><p>body</p></PopoutWindow>);
    const win = screen.getByTestId("chrome-window-one");
    expect(within(win).getByText("Task · Fix it")).toBeInTheDocument();
    expect(within(win).getByText("body")).toBeInTheDocument();
    expect(within(win).queryByLabelText("window.minimize")).toBeNull();
    expect(zOf("one")).toBeGreaterThan(DESKTOP_LAYERS.chat);
    expect(zOf("one")).toBeLessThan(DESKTOP_LAYERS.overlay);
  });

  it("puts the one pressed last in front, and Escape closes only that one", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <>
        <PopoutWindow title="A" appId="a" onClose={closeA}><p data-testid="in-a">a</p></PopoutWindow>
        <PopoutWindow title="B" appId="b" onClose={closeB}><p>b</p></PopoutWindow>
      </>,
    );
    expect(zOf("b")).toBeGreaterThan(zOf("a"));
    fireEvent.pointerDown(screen.getByTestId("in-a"));
    expect(zOf("a")).toBeGreaterThan(zOf("b"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
  });

  it("stops the Escape at the document, so the chat's own Escape never sees it", () => {
    const onClose = vi.fn();
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    try {
      render(<PopoutWindow title="t" appId="esc" onClose={onClose}><input data-testid="field" /></PopoutWindow>);
      fireEvent.keyDown(screen.getByTestId("field"), { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", reachedWindow);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("leaves an Escape typed somewhere else on the desktop, or one its content handled, alone", () => {
    const onClose = vi.fn();
    render(
      <div>
        <input data-testid="elsewhere" />
        <PopoutWindow title="t" appId="alone" onClose={onClose}>
          <input data-testid="menu" onKeyDown={(e) => { if (e.key === "Escape") e.preventDefault(); }} />
        </PopoutWindow>
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId("elsewhere"), { key: "Escape" });
    fireEvent.keyDown(screen.getByTestId("menu"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands focus back to what opened it when Escape closes it, and stops listening once gone", async () => {
    const closed = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>+</button>
          {open && (
            <PopoutWindow title="t" appId="focus" onClose={() => { closed(); setOpen(false); }}>
              <input data-testid="inside" autoFocus />
            </PopoutWindow>
          )}
        </div>
      );
    }
    render(<Host />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    const inside = await screen.findByTestId("inside");
    inside.focus();
    fireEvent.keyDown(inside, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("inside")).toBeNull());
    expect(document.activeElement).toBe(opener);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
