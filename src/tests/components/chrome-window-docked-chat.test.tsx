import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow from "@/components/ChromeWindow";
import * as kv from "@/lib/client-kv";
import { DESKTOP_GAP } from "@/lib/window-snap";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * A docked chat narrows the desktop, nothing more: every window keeps its own
 * size and place, can still be dragged, resized and maximized — and the one
 * that IS maximized sits DESKTOP_GAP inside the desktop on every side, the way
 * the chat floats, with the same gap as its right-hand margin — the chat and
 * the window share one number. (For a while every window was forced to fill
 * the pane beside the chat; the owner asked for the windows back.)
 */

// What page.tsx hands over: the docked panel's width plus the one gap.
const PANEL_WIDTH = 400;
const INSET = PANEL_WIDTH + DESKTOP_GAP;

// A desktop the default 800px window fits beside a 400px panel: jsdom's 1024
// would leave a 618px strip, and a window OPENED there is now fitted to it.
const W = 1440;
const H = 900;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
});

describe("a window beside a docked chat", () => {
  const win = (rightInset: number) => render(
    <ChromeWindow
      title="Terminal"
      appId="terminal"
      isActive
      zIndex={100}
      onClose={() => {}}
      onFocus={() => {}}
      onMinimize={() => {}}
      rightInset={rightInset}
    >
      <div>body</div>
    </ChromeWindow>,
  );

  it("keeps its own geometry and its controls while the chat is docked", () => {
    win(INSET);
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el).not.toHaveAttribute("data-dock-fill");
    expect(el.style.width).toBe("800px");
    expect(el.style.borderRadius).toBe("8px");
    expect(screen.getByRole("button", { name: "window.maximize" })).toBeInTheDocument();
  });

  it("sits a margin inside the desktop when maximized, the same margin between it and the chat", () => {
    win(INSET);
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el.style.left).toBe(`${DESKTOP_GAP}px`);
    expect(el.style.top).toBe(`${DESKTOP_GAP}px`);
    expect(el.style.width).toBe(`calc(100% - ${DESKTOP_GAP * 2 + INSET}px)`);
    expect(el.style.height).toContain(`${DESKTOP_GAP * 2}px`);
    // Corners kept, like the chat's.
    expect(el.style.borderRadius).toBe("8px");
  });

  it("is fitted to the strip beside the chat when it is OPENED there, so its controls can be reached", () => {
    // 1440 wide, the chat docked at 858: Files opened at its 1090px default was
    // centred in the 576px strip and kept its width — its right 534px,
    // minimize, maximize and close among them, sat under the chat, and a click
    // on Maximize landed in the transcript.
    const inset = 858 + DESKTOP_GAP;
    render(
      <ChromeWindow title="Files" appId="files" defaultWidth={1090} defaultHeight={640} isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} rightInset={inset}>
        <div>body</div>
      </ChromeWindow>,
    );
    const el = screen.getByTestId("chrome-window-files");
    const width = parseFloat(el.style.width);
    const left = parseFloat(el.style.left);
    expect(width).toBe(W - inset - DESKTOP_GAP * 2);
    expect(left).toBeGreaterThanOrEqual(DESKTOP_GAP);
    expect(left + width).toBeLessThanOrEqual(W - inset - DESKTOP_GAP);
    expect(screen.getByRole("button", { name: "window.maximize" })).toBeInTheDocument();
  });

  it("does not remember the fitted width as the app's size when it is closed", () => {
    // The close saved whatever the window measured at that moment: Files
    // fitted from 1090 to 564px beside the chat and closed with the X came up
    // 564 wide on every open after — with the chat undocked too — until the
    // owner resized it by hand. The saved size survives a fitted close.
    kv.setJSON("clawbox-winsize-files", { width: 1090, height: 640 });
    const inset = 858 + DESKTOP_GAP;
    render(
      <ChromeWindow title="Files" appId="files" defaultWidth={1090} defaultHeight={640} isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} rightInset={inset}>
        <div>body</div>
      </ChromeWindow>,
    );
    const el = screen.getByTestId("chrome-window-files");
    expect(parseFloat(el.style.width)).toBe(W - inset - DESKTOP_GAP * 2);

    fireEvent.click(screen.getByRole("button", { name: "window.close" }));
    expect(kv.getJSON("clawbox-winsize-files")).toEqual({ width: 1090, height: 640 });
  });

  it("still remembers a size the owner gave it by hand", () => {
    render(
      <ChromeWindow title="Store" appId="store" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}}>
        <div>body</div>
      </ChromeWindow>,
    );
    const el = screen.getByTestId("chrome-window-store");
    const corner = el.querySelector(".cursor-se-resize") as HTMLElement;
    fireEvent.mouseDown(corner, { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 550 });
    fireEvent.mouseUp(window, { clientX: 600, clientY: 550 });
    expect(el.style.width).toBe("900px");

    fireEvent.click(screen.getByRole("button", { name: "window.close" }));
    expect(kv.getJSON("clawbox-winsize-store")).toEqual({ width: 900, height: 650 });
  });

  it("keeps its size when the chat is docked AFTER it opened: the desktop narrows, the window does not", () => {
    const at = (rightInset: number) => (
      <ChromeWindow title="Terminal" appId="terminal" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} rightInset={rightInset}>
        <div>body</div>
      </ChromeWindow>
    );
    const { rerender } = render(at(0));
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el.style.width).toBe("800px");
    // A strip narrower than the window; it stays where and what it was.
    rerender(at(858 + DESKTOP_GAP));
    expect(el.style.width).toBe("800px");
  });

  it("keeps the same margin on both sides when no chat is docked", () => {
    win(0);
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    expect(screen.getByTestId("chrome-window-terminal").style.width).toBe(`calc(100% - ${DESKTOP_GAP * 2}px)`);
  });

  it("maximizes when the desktop asks, once per request", () => {
    const { rerender } = render(
      <ChromeWindow title="Coding Agent" appId="coding" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} maximizeSignal={undefined}>
        <div>body</div>
      </ChromeWindow>,
    );
    const el = screen.getByTestId("chrome-window-coding");
    expect(el.style.width).toBe("800px");
    rerender(
      <ChromeWindow title="Coding Agent" appId="coding" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} maximizeSignal={1}>
        <div>body</div>
      </ChromeWindow>,
    );
    expect(el.style.left).toBe(`${DESKTOP_GAP}px`);
    // The owner restores it by hand; the same signal value does not re-maximize.
    fireEvent.click(screen.getByRole("button", { name: "window.restore" }));
    expect(el.style.width).toBe("800px");
  });
});
