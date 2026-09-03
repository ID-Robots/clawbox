import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow, { DOCK_GAP } from "@/components/ChromeWindow";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * A docked chat narrows the desktop, nothing more: every window keeps its own
 * size and place, can still be dragged, resized and maximized — and the one
 * that IS maximized stops DOCK_GAP short of the chat instead of touching it.
 * (For a while every window was forced to fill the pane beside the chat; the
 * owner asked for the windows back.)
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

  it("keeps its own geometry and its controls while the chat is docked", () => {
    win(412);
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el).not.toHaveAttribute("data-dock-fill");
    expect(el.style.width).toBe("800px");
    expect(el.style.borderRadius).toBe("8px");
    expect(screen.getByRole("button", { name: "window.maximize" })).toBeInTheDocument();
  });

  it("leaves a small gap to the chat when maximized", () => {
    win(412);
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    const el = screen.getByTestId("chrome-window-terminal");
    expect(el.style.left).toBe("0px");
    expect(el.style.top).toBe("0px");
    expect(el.style.width).toBe(`calc(100% - ${412 + DOCK_GAP}px)`);
    expect(el.style.borderRadius).toBe("0px");
  });

  it("fills the whole width when maximized with no chat docked", () => {
    win(0);
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    expect(screen.getByTestId("chrome-window-terminal").style.width).toBe("calc(100% - 0px)");
  });
});
