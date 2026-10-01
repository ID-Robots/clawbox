import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow, { type WindowMode } from "@/components/ChromeWindow";
import { DESKTOP_GAP } from "@/lib/window-snap";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * A refresh brings a window back the way it was left (TASK-1306): maximized
 * windows maximized, snapped ones snapped to the same zone of THIS desktop, and
 * Restore takes either back to the place it had before — and the desktop hears
 * every change of mode so it can save it.
 */

const W = 1440;
const H = 900;
const SHELF = 56;

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: W, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
});

function win(props: Partial<React.ComponentProps<typeof ChromeWindow>> = {}) {
  return render(
    <ChromeWindow
      title="Files"
      appId="files"
      windowId="files-1"
      isActive
      zIndex={100}
      onClose={() => {}}
      onFocus={() => {}}
      onMinimize={() => {}}
      {...props}
    >
      <div>body</div>
    </ChromeWindow>,
  );
}

describe("a window restored maximized", () => {
  it("comes back maximized, and Restore takes it to the place it had before", () => {
    const onModeChange = vi.fn<(mode: WindowMode) => void>();
    win({
      initialPosition: { x: 200, y: 120 },
      initialSize: { width: 700, height: 480 },
      initialMaximized: true,
      initialRestore: { x: 200, y: 120, width: 700, height: 480 },
      onModeChange,
    });
    const el = screen.getByTestId("chrome-window-files");
    expect(el).toHaveAttribute("data-maximized", "true");
    expect(el).toHaveAttribute("data-window-id", "files-1");
    expect(el.style.left).toBe(`${DESKTOP_GAP}px`);
    // Mounting reports nothing: the desktop already knows how it started.
    expect(onModeChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "window.restore" }));
    expect(el).not.toHaveAttribute("data-maximized");
    expect(el.style.left).toBe("200px");
    expect(el.style.width).toBe("700px");
    expect(onModeChange).toHaveBeenLastCalledWith({
      maximized: false,
      snapped: null,
      restore: null,
      geometry: { x: 200, y: 120, width: 700, height: 480 },
    });
  });

  it("tells the desktop when it is maximized, with the rect Restore goes back to", () => {
    const onModeChange = vi.fn<(mode: WindowMode) => void>();
    win({ initialPosition: { x: 50, y: 60 }, initialSize: { width: 640, height: 400 }, onModeChange });
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    expect(onModeChange).toHaveBeenLastCalledWith({
      maximized: true,
      snapped: null,
      restore: { x: 50, y: 60, width: 640, height: 400 },
      geometry: { x: 50, y: 60, width: 640, height: 400 },
    });
  });
});

describe("a window restored snapped", () => {
  it("takes its zone's rect on this desktop, and Restore takes it back to where it was", () => {
    const onModeChange = vi.fn<(mode: WindowMode) => void>();
    win({
      // The rect it was saved with came from a wider screen; the zone is what counts.
      initialPosition: { x: 960, y: 0 },
      initialSize: { width: 960, height: 1024 },
      initialSnapped: "right",
      initialRestore: { x: 100, y: 80, width: 600, height: 420 },
      onModeChange,
    });
    const el = screen.getByTestId("chrome-window-files");
    expect(el).toHaveAttribute("data-snapped", "right");
    expect(el.style.left).toBe(`${W / 2}px`);
    expect(el.style.width).toBe(`${W / 2}px`);
    expect(el.style.height).toBe(`${H - SHELF}px`);

    // Maximize, then Restore: back to the free rect it had before it was snapped.
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    expect(onModeChange).toHaveBeenLastCalledWith(expect.objectContaining({
      maximized: true,
      snapped: null,
      restore: { x: 100, y: 80, width: 600, height: 420 },
    }));
    act(() => { fireEvent.click(screen.getByRole("button", { name: "window.restore" })); });
    expect(el.style.left).toBe("100px");
    expect(el.style.width).toBe("600px");
  });

  it("marks the window in front for the desktop and its tests", () => {
    const { rerender } = win({ isActive: false });
    expect(screen.getByTestId("chrome-window-files")).toHaveAttribute("data-active", "false");
    rerender(
      <ChromeWindow title="Files" appId="files" isActive zIndex={101} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}}>
        <div>body</div>
      </ChromeWindow>,
    );
    expect(screen.getByTestId("chrome-window-files")).toHaveAttribute("data-active", "true");
  });
});
