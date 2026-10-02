import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow from "@/components/ChromeWindow";
import { setDeskScreens, type DeskScreen } from "@/lib/desktop-screens";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * A desktop window over a ROW of monitors (monitor mode), on the test
 * machine's layout: two 2560x1440 monitors side by side, the MAIN one (with
 * the shelf) on the left, the page one window spread over both.
 */

const MON_W = 2560;
const MON_H = 1440;
const SHELF = 56;

function scr(id: string, x: number, y: number, width: number, height: number, main = false): DeskScreen {
  return { id, label: id, x, y, width, height, main };
}

const ROW = [scr("hdmi", 0, 0, MON_W, MON_H, true), scr("dp", MON_W, 0, MON_W, MON_H)];

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 2 * MON_W, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: MON_H, configurable: true });
});

afterEach(() => {
  act(() => setDeskScreens(null));
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

const el = () => screen.getByTestId("chrome-window-files");
const titleBar = () => screen.getByText("Files").parentElement!.parentElement!;

describe("a window restored snapped before the page knows its monitors", () => {
  // The desktop's state is read before the monitors are (one request against
  // two in a row and a wlr-randr spawn), so a restored window almost always
  // mounts on the one screen there is then: the viewport, the whole row.

  it("goes back to the monitor it was snapped on once the monitors are known", () => {
    // Snapped left on the RIGHT-hand monitor, as saved.
    win({ initialPosition: { x: MON_W, y: 0 }, initialSize: { width: MON_W / 2, height: MON_H }, initialSnapped: "left" });
    act(() => setDeskScreens(ROW));
    expect(el()).toHaveAttribute("data-snapped", "left");
    expect(el().style.left).toBe(`${MON_W}px`);
    expect(el().style.width).toBe(`${MON_W / 2}px`);
    // The other monitor is all window space: no shelf there.
    expect(el().style.height).toBe(`${MON_H}px`);
  });

  it("stays on the main monitor when that is where it was snapped", () => {
    // Snapped right on the MAIN monitor: its viewport-wide rect's centre fell
    // on the other monitor, which is where it used to end up.
    win({ initialPosition: { x: MON_W / 2, y: 0 }, initialSize: { width: MON_W / 2, height: MON_H - SHELF }, initialSnapped: "right" });
    act(() => setDeskScreens(ROW));
    expect(el().style.left).toBe(`${MON_W / 2}px`);
    expect(el().style.width).toBe(`${MON_W / 2}px`);
    expect(el().style.height).toBe(`${MON_H - SHELF}px`);
  });

  it("fills the monitor it was snapped full on", () => {
    win({ initialPosition: { x: 0, y: 0 }, initialSize: { width: MON_W, height: MON_H - SHELF }, initialSnapped: "top" });
    act(() => setDeskScreens(ROW));
    expect(el().style.left).toBe("0px");
    expect(el().style.width).toBe(`${MON_W}px`);
  });

  it("is where it was saved at once when the monitors were known first", () => {
    act(() => setDeskScreens(ROW));
    win({ initialPosition: { x: MON_W, y: 0 }, initialSize: { width: MON_W / 2, height: MON_H }, initialSnapped: "left" });
    expect(el().style.left).toBe(`${MON_W}px`);
  });

  it("follows its own rect, not the saved one, once the monitors are known", () => {
    const { rerender } = win({ initialPosition: { x: MON_W, y: 0 }, initialSize: { width: MON_W / 2, height: MON_H }, initialSnapped: "left" });
    act(() => setDeskScreens(ROW));
    // A later relayout (the chat docks) keeps it where it is.
    rerender(
      <ChromeWindow title="Files" appId="files" windowId="files-1" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} rightInset={300}
        initialPosition={{ x: MON_W, y: 0 }} initialSize={{ width: MON_W / 2, height: MON_H }} initialSnapped="left">
        <div>body</div>
      </ChromeWindow>,
    );
    expect(el().style.left).toBe(`${MON_W}px`);
    expect(el().style.width).toBe(`${MON_W / 2}px`);
  });
});

describe("the snap preview while a window is dragged", () => {
  it("is drawn on the monitor the window will be dropped on, and the drop lands there", () => {
    act(() => setDeskScreens(ROW));
    win({ initialPosition: { x: 400, y: 200 }, initialSize: { width: 800, height: 600 } });
    fireEvent.mouseDown(titleBar(), { clientX: 800, clientY: 210 });
    // To the far edge of the right-hand monitor.
    fireEvent.mouseMove(window, { clientX: 2 * MON_W - 5, clientY: 700 });
    const plate = screen.getByTestId("snap-preview");
    expect(plate.style.left).toBe(`${MON_W + MON_W / 2}px`);
    expect(plate.style.width).toBe(`${MON_W / 2}px`);
    expect(plate.style.height).toBe(`${MON_H}px`);
    fireEvent.mouseUp(window, { clientX: 2 * MON_W - 5, clientY: 700 });
    expect(screen.queryByTestId("snap-preview")).toBeNull();
    expect(el()).toHaveAttribute("data-snapped", "right");
    expect(el().style.left).toBe(plate.style.left);
    expect(el().style.width).toBe(plate.style.width);
  });

  it("is drawn where it always was with one screen", () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    win({ initialPosition: { x: 400, y: 200 }, initialSize: { width: 600, height: 400 } });
    fireEvent.mouseDown(titleBar(), { clientX: 700, clientY: 210 });
    fireEvent.mouseMove(window, { clientX: 1438, clientY: 400 });
    const plate = screen.getByTestId("snap-preview");
    expect(plate.style.left).toBe("720px");
    expect(plate.style.width).toBe("720px");
    expect(plate.style.height).toBe(`${900 - SHELF}px`);
    fireEvent.mouseUp(window, { clientX: 1438, clientY: 400 });
  });
});

describe("a window stretched across the seam", () => {
  const wide = { initialPosition: { x: 1000, y: 100 }, initialSize: { width: 3500, height: 900 } };

  it("keeps its width when it is restored", () => {
    act(() => setDeskScreens(ROW));
    win(wide);
    expect(el().style.width).toBe("3500px");
  });

  it("keeps its width when the chat docks or the monitors are read again", () => {
    act(() => setDeskScreens(ROW));
    const { rerender } = win(wide);
    rerender(
      <ChromeWindow title="Files" appId="files" windowId="files-1" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}} rightInset={406} {...wide}>
        <div>body</div>
      </ChromeWindow>,
    );
    expect(el().style.width).toBe("3500px");
    act(() => setDeskScreens(ROW.map((s) => ({ ...s, label: `${s.label}!` }))));
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(el().style.width).toBe("3500px");
    expect(el().style.left).toBe("1000px");
  });

  it("is still held to the row it is on", () => {
    act(() => setDeskScreens(ROW));
    win({ initialPosition: { x: 0, y: 100 }, initialSize: { width: 9000, height: 900 } });
    expect(el().style.width).toBe(`${2 * MON_W}px`);
  });
});
