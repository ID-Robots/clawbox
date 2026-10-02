import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import SnapPreviewOverlay from "@/components/SnapPreviewOverlay";
import ToastHost, { TOAST_EVENT } from "@/components/ToastHost";
import MonitorIdentifyOverlay, { IDENTIFY_MS } from "@/components/MonitorIdentifyOverlay";
import { MONITORS_IDENTIFY_EVENT, identifyMonitors, setDeskScreens, type DeskScreen } from "@/lib/desktop-screens";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

/**
 * The desktop's smaller surfaces over a ROW of monitors (monitor mode): each
 * belongs where the drop, the shelf or the Monitors tab says, and — with no
 * layout, every Jetson and every browser tab — exactly where it always was.
 *
 * The row is the test machine's: two 2560x1440 monitors, the MAIN one on the
 * left, so the viewport's right-hand corner is the OTHER monitor's.
 */

const MON_W = 2560;
const MON_H = 1440;

function scr(id: string, x: number, y: number, width: number, height: number, main = false): DeskScreen {
  return { id, label: `Monitor ${id}`, x, y, width, height, main };
}

const ROW = [scr("a", 0, 0, MON_W, MON_H, true), scr("b", MON_W, 0, MON_W, MON_H)];

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

beforeEach(() => {
  setViewport(2 * MON_W, MON_H);
});

afterEach(() => {
  act(() => setDeskScreens(null));
});

describe("the snap preview plate", () => {
  it("stands on the monitor under the point it is given — the one the drop will use", () => {
    act(() => setDeskScreens(ROW));
    render(<SnapPreviewOverlay zone="right" at={{ x: 2 * MON_W - 5, y: 700 }} />);
    const plate = screen.getByTestId("snap-preview");
    expect(plate.style.left).toBe(`${MON_W + MON_W / 2}px`);
    expect(plate.style.width).toBe(`${MON_W / 2}px`);
    expect(plate.style.height).toBe(`${MON_H}px`);
  });

  it("stands on the main monitor without a point, and on the viewport with one screen", () => {
    act(() => setDeskScreens(ROW));
    const { unmount } = render(<SnapPreviewOverlay zone="right" />);
    expect(screen.getByTestId("snap-preview").style.left).toBe(`${MON_W / 2}px`);
    unmount();
    act(() => setDeskScreens(null));
    setViewport(1000, 800);
    render(<SnapPreviewOverlay zone="right" rightInset={200} at={{ x: 9999, y: 9999 }} />);
    // (1000 - 200) / 2, exactly what it drew before monitor mode.
    expect(screen.getByTestId("snap-preview").style.left).toBe("400px");
  });
});

describe("the toast stack", () => {
  function toast(message: string) {
    act(() => {
      window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message } }));
    });
  }

  it("keeps its classes alone — and its old corner — with no monitor layout", () => {
    render(<ToastHost />);
    toast("Hello");
    const host = screen.getByTestId("toast-host");
    expect(host.className).toContain("bottom-20");
    expect(host.className).toContain("right-4");
    expect(host.style.right).toBe("");
    expect(host.style.bottom).toBe("");
  });

  it("stands in the MAIN monitor's corner over a row of monitors", () => {
    act(() => setDeskScreens(ROW));
    render(<ToastHost />);
    toast("Hello");
    const host = screen.getByTestId("toast-host");
    // right-4 and bottom-20, measured from the main monitor's corner.
    expect(host.style.right).toBe(`${16 + MON_W}px`);
    expect(host.style.bottom).toBe("80px");
  });

  it("stays above a shorter main monitor's bottom, not in the strip below it no monitor shows", () => {
    setViewport(MON_W + 1920, MON_H);
    act(() => setDeskScreens([scr("big", 0, 0, MON_W, MON_H), scr("small", MON_W, 0, 1920, 1080, true)]));
    render(<ToastHost />);
    toast("Hello");
    const host = screen.getByTestId("toast-host");
    expect(host.style.right).toBe("16px");
    expect(host.style.bottom).toBe(`${80 + (MON_H - 1080)}px`);
  });

  it("moves with the layout while it is up", () => {
    render(<ToastHost />);
    toast("Hello");
    const host = screen.getByTestId("toast-host");
    expect(host.style.right).toBe("");
    act(() => setDeskScreens(ROW));
    expect(host.style.right).toBe(`${16 + MON_W}px`);
  });
});

describe("Identify", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function shown() {
    return screen.queryAllByTestId("monitor-identify").map((el) => ({
      id: el.getAttribute("data-monitor-id"),
      text: el.textContent,
    }));
  }

  it("numbers the monitors left to right when the event names no order", () => {
    render(<MonitorIdentifyOverlay screens={ROW} />);
    act(() => {
      window.dispatchEvent(new Event(MONITORS_IDENTIFY_EVENT));
    });
    expect(shown()).toEqual([
      { id: "a", text: "1Monitor asettings.monitors.main" },
      { id: "b", text: "2Monitor b" },
    ]);
  });

  it("numbers them the way the Monitors tab does — its draft order, not the one on screen", () => {
    // The owner dragged b to the front and has not applied it: the tab
    // calls b "1", and so must b's own screen.
    act(() => setDeskScreens(ROW));
    render(<MonitorIdentifyOverlay screens={ROW} />);
    act(() => {
      identifyMonitors(["b", "a"]);
    });
    expect(shown()).toEqual([
      { id: "a", text: "2Monitor asettings.monitors.main" },
      { id: "b", text: "1Monitor b" },
    ]);
  });

  it("shows a monitor the tab does not number by its name alone", () => {
    // Turned off in the draft, still on until Apply.
    render(<MonitorIdentifyOverlay screens={ROW} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(MONITORS_IDENTIFY_EVENT, { detail: { order: ["b"] } }));
    });
    expect(shown()).toEqual([
      { id: "a", text: "Monitor asettings.monitors.main" },
      { id: "b", text: "1Monitor b" },
    ]);
  });

  it("goes away on its own", () => {
    vi.useFakeTimers();
    render(<MonitorIdentifyOverlay screens={ROW} />);
    act(() => {
      window.dispatchEvent(new Event(MONITORS_IDENTIFY_EVENT));
    });
    expect(shown()).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(IDENTIFY_MS);
    });
    expect(shown()).toHaveLength(0);
  });
});
