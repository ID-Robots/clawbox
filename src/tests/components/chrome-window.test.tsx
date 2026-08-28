import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow from "@/components/ChromeWindow";

// useT without a provider returns the raw key, so role-name queries need this.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "window.minimize": "Minimize",
        "window.maximize": "Maximize",
        "window.restore": "Restore",
        "window.close": "Close",
      };
      return translations[key] ?? key;
    },
  }),
}));

function renderWindow(overrides: Partial<React.ComponentProps<typeof ChromeWindow>> = {}) {
  const onClose = vi.fn();
  const onFocus = vi.fn();
  const onMinimize = vi.fn();
  const utils = render(
    <ChromeWindow
      title="Settings"
      icon={<span data-testid="win-icon" />}
      appId="settings"
      isActive
      zIndex={1}
      onClose={onClose}
      onFocus={onFocus}
      onMinimize={onMinimize}
      {...overrides}
    >
      <div data-testid="win-body">body</div>
    </ChromeWindow>,
  );
  return { ...utils, onClose, onFocus, onMinimize };
}

describe("ChromeWindow — the chat popup's shell", () => {
  it("is a region named by its title, with the icon and title inside the strip", () => {
    renderWindow();
    const region = screen.getByRole("region", { name: "Settings" });
    expect(region).toBe(screen.getByTestId("chrome-window-settings"));
    const strip = screen.getByTestId("chrome-window-strip");
    expect(strip).toContainElement(screen.getByText("Settings"));
    expect(strip).toContainElement(screen.getByTestId("win-icon"));
    expect(screen.getByTestId("win-icon").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  describe("controls", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("exposes Minimize, Maximize and Close as real, tabbable buttons that fire after their animations", () => {
      const { onClose, onMinimize } = renderWindow();
      for (const name of ["Minimize", "Maximize", "Close"]) {
        const btn = screen.getByRole("button", { name });
        expect(btn.tagName).toBe("BUTTON");
        expect(btn).toHaveAttribute("type", "button");
        expect(btn).not.toHaveAttribute("tabindex", "-1");
        expect(btn).toHaveClass("win-strip-btn");
      }

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(150); });
      expect(onClose).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
      expect(onMinimize).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(250); });
      expect(onMinimize).toHaveBeenCalledTimes(1);
    });
  });

  it("swaps Maximize for Restore and squares the corners while maximised", () => {
    renderWindow();
    const root = screen.getByTestId("chrome-window-settings");
    expect(root.getAttribute("style")).toContain("var(--win-radius)");

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();
    expect(root.style.borderRadius).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(root.getAttribute("style")).toContain("var(--win-radius)");
  });

  it("paints the strip and the ground from the shared tokens, strip before content", () => {
    renderWindow();
    const root = screen.getByTestId("chrome-window-settings");
    const strip = screen.getByTestId("chrome-window-strip");
    expect(strip.style.height).toBe("36px");
    expect(strip.getAttribute("style")).toContain("var(--win-strip-fade)");
    expect(root.getAttribute("style")).toContain("var(--win-ground)");

    const host = root.querySelector("[data-chrome-window-content]") as HTMLElement;
    expect(host).not.toBeNull();
    expect(host).toHaveClass("flex-1", "min-h-0", "bg-[var(--win-ground)]");
    expect(host).toContainElement(screen.getByTestId("win-body"));
    // The strip precedes the host: nothing renders under the drag handle.
    expect(strip.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("drags by the strip but never by a control", () => {
    renderWindow({ initialPosition: { x: 100, y: 50 } });
    const root = screen.getByTestId("chrome-window-settings");
    const before = root.style.left;
    expect(before).toBe("100px");

    fireEvent.mouseDown(screen.getByRole("button", { name: "Close" }), { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 210, clientY: 10 });
    expect(root.style.left).toBe(before);
    fireEvent.mouseUp(window, { clientX: 210, clientY: 10 });

    fireEvent.mouseDown(screen.getByTestId("chrome-window-strip"), { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 210, clientY: 10 });
    expect(root.style.left).toBe("300px");
    fireEvent.mouseUp(window, { clientX: 210, clientY: 10 });
  });

  it("focuses an inactive window when one of its controls is pressed", () => {
    const { onFocus } = renderWindow({ isActive: false });
    expect(screen.getByTestId("chrome-window-settings")).toHaveAttribute("data-active", "false");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Maximize" }));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
