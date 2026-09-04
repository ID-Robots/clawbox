import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow from "@/components/ChromeWindow";
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
