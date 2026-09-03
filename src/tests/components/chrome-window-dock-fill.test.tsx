import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow, { DOCK_FILL_MARGIN } from "@/components/ChromeWindow";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * With the chat docked the desktop is two panes, and every window fills the
 * other one with a small margin all round — the owner asked for exactly that.
 * Undocked, a window is a window again: its own size, its own place.
 */
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

  it("fills the pane with the margin on every side, keeps its corners, and offers no maximize", () => {
    win(412);
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el).toHaveAttribute("data-dock-fill", "true");
    expect(el.style.left).toBe(`${DOCK_FILL_MARGIN}px`);
    expect(el.style.top).toBe(`${DOCK_FILL_MARGIN}px`);
    expect(el.style.width).toBe(`calc(100% - ${412 + DOCK_FILL_MARGIN}px)`);
    expect(el.style.height).toContain(`${DOCK_FILL_MARGIN * 2}px`);
    expect(el.style.borderRadius).toBe("8px");
    expect(screen.queryByRole("button", { name: "window.maximize" })).toBeNull();
  });

  it("is an ordinary window when the chat is not docked", () => {
    win(0);
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el).not.toHaveAttribute("data-dock-fill");
    expect(el.style.width).toBe("800px");
    expect(screen.getByRole("button", { name: "window.maximize" })).toBeInTheDocument();
  });
});
