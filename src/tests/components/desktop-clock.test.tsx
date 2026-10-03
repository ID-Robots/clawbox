/**
 * The desktop's clock (src/lib/use-desktop-clock.ts), read by the shelf and the
 * power menu themselves.
 *
 * It used to be state of the desktop's root component, ticking every second
 * and handed down as props: every new minute rebuilt the whole desktop — every
 * window and the app in it, the chat, the mascot — to change one label. Now the
 * two labels read one shared clock. Pinned here: they show the same text and
 * turn the minute together (as when they shared the root's state), a label
 * re-renders only when its text changes, a label mounted later paints the time
 * of NOW, and nothing ticks once no label is on screen.
 */
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import ChromeShelf from "@/components/ChromeShelf";
import SystemTray from "@/components/SystemTray";
import { clockLocaleTag, useDesktopClock } from "@/lib/use-desktop-clock";
import { _resetSessionUserForTest } from "@/lib/use-session-user";

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key, locale: "en" }),
}));

const tag = () => clockLocaleTag("en", navigator.languages);
const timeAt = (d: Date) => d.toLocaleTimeString(tag(), { hour: "2-digit", minute: "2-digit" });
const dateAt = (d: Date) => d.toLocaleDateString(tag(), { weekday: "long", month: "long", day: "numeric" });

// Renders are counted by a Profiler around the label: a component may not
// write to outside state while it renders.
const seen = { renders: 0 };
const countRender = () => { seen.renders += 1; };
function Label({ id }: { id: string }) {
  const { time } = useDesktopClock();
  return <span data-testid={id}>{time}</span>;
}
function Probe({ id = "probe" }: { id?: string }) {
  return (
    <Profiler id={id} onRender={countRender}>
      <Label id={id} />
    </Profiler>
  );
}

beforeEach(() => {
  seen.renders = 0;
  _resetSessionUserForTest();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  // 09:27:58 local, two seconds before a new minute.
  vi.useFakeTimers({ now: new Date(2026, 9, 2, 9, 27, 58), toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the desktop clock", () => {
  it("shows the shelf and an open power menu the same time, and turns their minute together", () => {
    render(
      <>
        <ChromeShelf apps={[]} onAppClick={() => {}} onLauncherClick={() => {}} onTrayClick={() => {}} />
        <SystemTray isOpen onClose={() => {}} />
      </>,
    );
    const shelf = screen.getByTestId("shelf-tray-button");
    const tray = screen.getByTestId("system-tray");
    const before = new Date();
    expect(shelf).toHaveTextContent(timeAt(before));
    expect(tray).toHaveTextContent(timeAt(before));
    expect(tray).toHaveTextContent(dateAt(before));

    act(() => { vi.advanceTimersByTime(2000); });
    const after = new Date();
    expect(timeAt(after)).not.toBe(timeAt(before));
    expect(shelf).toHaveTextContent(timeAt(after));
    expect(tray).toHaveTextContent(timeAt(after));
  });

  it("re-renders a label when its text changes, not every second", () => {
    vi.setSystemTime(new Date(2026, 9, 2, 9, 27, 1));
    render(<Probe />);
    expect(seen.renders).toBe(1);
    act(() => { vi.advanceTimersByTime(55_000); });
    expect(seen.renders).toBe(1);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(seen.renders).toBe(2);
    expect(screen.getByTestId("probe")).toHaveTextContent(timeAt(new Date()));
  });

  it("paints a label mounted later with the time of now, never a stale or an empty one", () => {
    render(<Probe id="first" />);
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    render(<Probe id="later" />);
    expect(screen.getByTestId("later")).toHaveTextContent(timeAt(new Date()));
    expect(screen.getByTestId("later").textContent).not.toBe("");
  });

  it("ticks only while a label is on screen", () => {
    expect(vi.getTimerCount()).toBe(0);
    const { unmount } = render(<Probe />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    // A label mounted after a while away formats afresh.
    act(() => { vi.advanceTimersByTime(3 * 60_000); });
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent(timeAt(new Date()));
  });
});

describe("clockLocaleTag", () => {
  it("takes the browser's region for the desktop's language, and only that", () => {
    expect(clockLocaleTag("en", ["en-GB", "en"])).toBe("en-GB");
    expect(clockLocaleTag("en", ["en", "en-GB"])).toBe("en-GB");
    expect(clockLocaleTag("de", ["en-US", "en"])).toBe("de");
    expect(clockLocaleTag("en", undefined)).toBe("en");
  });
});
