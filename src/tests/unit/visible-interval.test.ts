// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBoxOwnScreen, setVisibleInterval } from "@/lib/visible-interval";
import { KIOSK_BAR_VAR } from "@/lib/kiosk-bar-inset";
import { setMonitorSessionWindow } from "@/lib/desktop-screens";

/**
 * The desktop's always-on polls — the owner-notice ring, the Telegram pairing
 * requests, the version check — asked the box at the full rate behind a hidden
 * tab (a phone, a laptop tab left open, the tunnel). `setVisibleInterval` is
 * the rule they keep now, the one the chat's polls already kept: a tick that
 * falls due while the page is hidden is not run, the visible edge asks once at
 * once — and a poll of expiring events keeps a slower cadence while hidden.
 */

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date", "performance"] });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe("setVisibleInterval", () => {
  it("ticks like setInterval on a page that is on screen — and not on install", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6000);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });

  it("asks nothing while the page is hidden, and once at once when it is shown again", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 20_000);
    setVisibility("hidden");
    vi.advanceTimersByTime(5 * 60_000);
    expect(tick).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(1);
    // …and back on its clock from there.
    vi.advanceTimersByTime(20_000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("asks nothing extra for a page hidden and shown again within one interval", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 20_000);
    vi.advanceTimersByTime(5_000);
    setVisibility("hidden");
    vi.advanceTimersByTime(5_000);
    setVisibility("visible");
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("asks nothing on the way TO hidden", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000);
    setVisibility("hidden");
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("keeps a slower cadence behind a hidden tab when told to — for events that expire", () => {
    // The ring: every 2 s on screen, every 20 s hidden — inside the minute an
    // entry lives, so nothing pushed while the page is away is missed.
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000, { hiddenMs: 20_000 });
    setVisibility("hidden");
    vi.advanceTimersByTime(18_000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(4);
    // Back on screen: the tick that fell due meanwhile is asked at once, then
    // the 2 s clock again.
    vi.advanceTimersByTime(2000);
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(6);
    stop();
  });

  it("stops for good, the visible edge included", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000);
    setVisibility("hidden");
    vi.advanceTimersByTime(4000);
    stop();
    setVisibility("visible");
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });
});

/**
 * The box's own screen can be hidden too: in the kiosk the desktop is one tab
 * of the kiosk's Chrome, hidden whenever the owner is on another of its tabs,
 * and the ring's entries open pages THERE. Slowed to 20 s they arrived up to
 * 20 s after the agent said it had opened them, so the ring asks the question
 * at every tick and keeps its 2 s on that screen.
 */
describe("setVisibleInterval — a hidden cadence that depends on the screen", () => {
  it("asks a function for the hidden cadence at every tick, so a change after install is followed", () => {
    let boxScreen = false;
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000, { hiddenMs: () => (boxScreen ? 2000 : 20_000) });
    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    // The kiosk bar announces itself after the page has mounted.
    boxScreen = true;
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(8000);
    expect(tick).toHaveBeenCalledTimes(5);
    stop();
  });
});

describe("setVisibleInterval — a hidden cadence on a browser's jittered timer", () => {
  // A browser fires a repeating timer on its own schedule, not `ms` after the
  // previous callback: a tick that ran late leaves the next one a few ms
  // short. Judged by the elapsed time, that tick was skipped — the box's own
  // screen was read every 4 s instead of every 2 s, and a 20 s hidden cadence
  // slipped to 22 s.
  let clock = 0;

  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  it("runs every tick while hidden, whatever the timer's jitter", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000, { hiddenMs: () => 2000 });
    setVisibility("hidden");
    // The first callback ran 5 ms late, the second on its schedule.
    clock = 2005;
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    clock = 4000;
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  /**
   * One interval callback, `late` ms after the beat it was due on — the way a
   * browser fires a repeating timer: on its own schedule, each callback a
   * little late and the next one still due on the beat.
   */
  function beat(n: number, late: number) {
    clock = n * 2000 + late;
    vi.advanceTimersByTime(2000);
  }

  it("keeps a 20 s hidden cadence at 20 s when the run itself was late (it used to slip to 22 s)", () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000, { hiddenMs: 20_000 });
    setVisibility("hidden");
    // Beat 10 runs 7 ms late; every beat after it is on time, so beat 20 is
    // 19 993 ms after that run — a whole cadence by the beat, a few ms short
    // by the clock.
    for (let n = 1; n <= 10; n++) beat(n, n === 10 ? 7 : 0);
    expect(tick).toHaveBeenCalledTimes(1);
    for (let n = 11; n <= 19; n++) beat(n, 0);
    expect(tick).toHaveBeenCalledTimes(1);
    beat(20, 0);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("runs on every tenth beat for minutes of jittered callbacks, never on the ninth", () => {
    const tick = vi.fn();
    const runsAt: number[] = [];
    tick.mockImplementation(() => runsAt.push(Math.round((clock - (clock % 2000)) / 2000)));
    const stop = setVisibleInterval(tick, 2000, { hiddenMs: 20_000 });
    setVisibility("hidden");
    // Late by 0–400 ms, in an order with no pattern to it.
    const lateness = [0, 120, 7, 380, 45, 260, 3, 199, 400, 61, 15, 333];
    for (let n = 1; n <= 100; n++) beat(n, lateness[(n * 7) % lateness.length]);
    expect(runsAt).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    stop();
  });

  it("rounds a hidden cadence that is not a whole number of beats UP, never down", () => {
    // 5 s on a 2 s beat: every third beat (6 s), not every second (4 s).
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 2000, { hiddenMs: 5_000 });
    setVisibility("hidden");
    for (let n = 1; n <= 12; n++) beat(n, n % 3 === 0 ? 150 : 0);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
  });
});

describe("isBoxOwnScreen", () => {
  const realMatchMedia = window.matchMedia;

  function displayMode(mode: "browser" | "standalone" | "fullscreen") {
    window.matchMedia = ((query: string) => ({
      matches: query === `(display-mode: ${mode})`,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
    setMonitorSessionWindow(false);
  });

  it("is no for a browser tab — a phone, a laptop on the LAN, the tunnel", () => {
    displayMode("browser");
    expect(isBoxOwnScreen()).toBe(false);
  });

  it("is yes in the kiosk, where the bar has set its height on the page", () => {
    displayMode("browser");
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "40px");
    expect(isBoxOwnScreen()).toBe(true);
  });

  it("is yes in the window a monitor session has answered", () => {
    displayMode("standalone");
    setMonitorSessionWindow(true);
    expect(isBoxOwnScreen()).toBe(true);
  });

  // The desktop installed as an app on a phone (public/manifest.json is
  // `standalone`), and a tab put in full screen — F11, or the shelf's own
  // full-screen button. Both used to count as the box's screen, so a hidden
  // phone read the ring every 2 s instead of every 20 s.
  it.each(["standalone", "fullscreen"] as const)("is no for an app display mode (%s) no monitor session has answered", (mode) => {
    displayMode(mode);
    expect(isBoxOwnScreen()).toBe(false);
  });

  it("is no where the display mode cannot be asked and there is no kiosk bar", () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(isBoxOwnScreen()).toBe(false);
  });

  it("is read on every call, never cached — the bar and the monitors' answer arrive after the page has mounted", () => {
    displayMode("standalone");
    expect(isBoxOwnScreen()).toBe(false);
    setMonitorSessionWindow(true);
    expect(isBoxOwnScreen()).toBe(true);
    setMonitorSessionWindow(false);
    displayMode("browser");
    expect(isBoxOwnScreen()).toBe(false);
    document.documentElement.style.setProperty(KIOSK_BAR_VAR, "40px");
    expect(isBoxOwnScreen()).toBe(true);
  });
});
