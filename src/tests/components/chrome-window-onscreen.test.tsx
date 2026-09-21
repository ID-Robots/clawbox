import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow from "@/components/ChromeWindow";
import { DESKTOP_GAP, TITLE_BAR_HEIGHT } from "@/lib/window-snap";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * A window must always be reachable BY HAND.
 *
 * Nothing clamped one to the visible desktop: the drag handler pinned the top
 * edge at 0 and left every other edge free, and a workspace restored from
 * `desktop_open_windows` was placed at whatever geometry it was saved with. A
 * window dropped with its title bar under the shelf was then lost for good —
 * there is no Close in any context menu, minimize/restore puts it back where it
 * was, and the next reload restores the same numbers.
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

describe("a window restored from a saved workspace", () => {
  it("is pulled back when its controls were saved past the right edge", () => {
    // run2 on the box: Files came back at x=1020 with an 800px width, so its
    // minimize, maximize and close buttons sat off a 1440px screen.
    win({ initialPosition: { x: 1020, y: 0 }, initialSize: { width: 800, height: 640 } });
    expect(screen.getByTestId("chrome-window-files").style.left).toBe(`${W - 800}px`);
  });

  it("is pulled back when its title bar was saved under the shelf", () => {
    win({ initialPosition: { x: 78, y: 875 }, initialSize: { width: 800, height: 640 } });
    expect(screen.getByTestId("chrome-window-files").style.top).toBe(`${H - SHELF - TITLE_BAR_HEIGHT}px`);
  });

  it("is shrunk when it is taller than the desktop it is opening on", () => {
    // run3b: Settings at 881px tall on an 844px desktop put its own bottom
    // resize handle under the shelf.
    win({ initialPosition: { x: -44, y: 20 }, initialSize: { width: 1102, height: 881 } });
    const el = screen.getByTestId("chrome-window-files");
    expect(el.style.height).toBe(`${H - SHELF}px`);
    expect(el.style.left).toBe("0px");
  });
});

describe("a window on a viewport that shrank", () => {
  /** Resize the browser under a window that is already on screen. */
  function shrinkTo(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
    act(() => { window.dispatchEvent(new Event("resize")); });
  }

  it("is shrunk to the smaller desktop, not just pushed against its edges", () => {
    // `clampWindowPosition` keeps the dimensions it is handed, so a window
    // sized on a 1440x900 display and carried onto a 900x600 one could only be
    // moved: pushed left it still hung 300px off the right, and its bottom
    // resize handle — the way out — stayed under the shelf.
    win({ initialPosition: { x: 200, y: 100 }, initialSize: { width: 1200, height: 700 } });
    const el = screen.getByTestId("chrome-window-files");
    expect(el.style.width).toBe("1200px");

    shrinkTo(900, 600);

    expect(Number.parseInt(el.style.width, 10)).toBeLessThanOrEqual(900);
    expect(Number.parseInt(el.style.height, 10)).toBeLessThanOrEqual(600 - SHELF);
    // Its right-hand controls are back on the screen, and the size it now has
    // is one the desktop can hold — which is what makes dragging it up a fix
    // rather than a way to trade one hidden edge for another. (The vertical
    // clamp is deliberately the TITLE BAR's, not the whole window's: see
    // clampWindowPosition.)
    expect(Number.parseInt(el.style.left, 10) + Number.parseInt(el.style.width, 10)).toBeLessThanOrEqual(900);
  });

  it("comes back from maximized at a size the smaller desktop can hold", () => {
    // Maximized geometry is a CSS calc that follows the viewport, so nothing
    // was wrong until Restore put back the pre-maximize numbers — measured on
    // the bigger screen — and only the position was clamped.
    win({ initialPosition: { x: 40, y: 40 }, initialSize: { width: 1300, height: 800 } });
    const el = screen.getByTestId("chrome-window-files");
    fireEvent.click(screen.getByLabelText("window.maximize"));

    shrinkTo(800, 560);
    fireEvent.click(screen.getByLabelText("window.restore"));

    expect(Number.parseInt(el.style.width, 10)).toBeLessThanOrEqual(800);
    expect(Number.parseInt(el.style.height, 10)).toBeLessThanOrEqual(560 - SHELF);
    expect(Number.parseInt(el.style.left, 10) + Number.parseInt(el.style.width, 10)).toBeLessThanOrEqual(800);
  });
});

describe("dragging a window", () => {
  it("stops with the title bar above the shelf", () => {
    win({ initialPosition: { x: 100, y: 100 }, initialSize: { width: 800, height: 640 } });
    const el = screen.getByTestId("chrome-window-files");
    const titleBar = el.querySelector("div")!;

    fireEvent.mouseDown(titleBar, { clientX: 500, clientY: 118 });
    fireEvent.mouseMove(window, { clientX: 500, clientY: 890 });
    fireEvent.mouseUp(window, { clientX: 500, clientY: 890 });

    // 100 + (890 - 118) = 872 without the clamp, which is under the shelf.
    expect(Number.parseInt(el.style.top, 10)).toBe(H - SHELF - TITLE_BAR_HEIGHT);
  });
});

describe("a snapped window beside the docked chat", () => {
  it("is re-laid against the panel when the panel is dragged wider", () => {
    // The snap rect was frozen at drop time: widening the chat by 80px buried
    // the window's controls under the panel, and the only way to reach them
    // again was to drag the window out.
    const { rerender } = render(
      <ChromeWindow
        title="Files"
        appId="files"
        isActive
        zIndex={100}
        onClose={() => {}}
        onFocus={() => {}}
        onMinimize={() => {}}
        rightInset={420 + DESKTOP_GAP}
      >
        <div>body</div>
      </ChromeWindow>,
    );
    const el = screen.getByTestId("chrome-window-files");
    const titleBar = el.querySelector("div")!;

    // Drop it against the right edge of what is left of the desktop.
    const rightEdge = W - (420 + DESKTOP_GAP) - 1;
    fireEvent.mouseDown(titleBar, { clientX: 400, clientY: 20 });
    fireEvent.mouseMove(window, { clientX: rightEdge, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: rightEdge, clientY: 300 });
    const snappedRight = Number.parseInt(el.style.left, 10) + Number.parseInt(el.style.width, 10);
    expect(snappedRight).toBe(W - (420 + DESKTOP_GAP));

    act(() => {
      rerender(
        <ChromeWindow
          title="Files"
          appId="files"
          isActive
          zIndex={100}
          onClose={() => {}}
          onFocus={() => {}}
          onMinimize={() => {}}
          rightInset={500 + DESKTOP_GAP}
        >
          <div>body</div>
        </ChromeWindow>,
      );
    });

    const relaidRight = Number.parseInt(el.style.left, 10) + Number.parseInt(el.style.width, 10);
    expect(relaidRight).toBe(W - (500 + DESKTOP_GAP));
  });
});
