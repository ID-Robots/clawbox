// An interval that stops asking the box while nobody can see the answer.
//
// The desktop keeps a few polls running for the life of the page — the
// owner-notice ring, the Telegram pairing requests, the version check — and
// none of them looked at whether the page was on screen. A phone with the
// desktop in a background tab, a laptop tab left open on the LAN or the remote
// tunnel kept asking at the full rate for answers nobody was reading; Chrome's
// own throttling of hidden timers only reaches one wake-up a minute after five
// minutes hidden, and not on every browser.
//
// The rule is the one the chat's polls already keep (`installPendingRefresh`):
// a tick that falls due while the page is HIDDEN is not run, and the page asks
// once, at once, on the edge back to visible — so what the owner comes back to
// is at least as fresh as it would have been.
//
// The box's own screen CAN be hidden: in the kiosk the desktop is one tab of
// the kiosk's Chrome and is hidden whenever the owner is on another of its
// tabs, and the monitor session's app window is hidden while it is minimised.
// For a poll of STATE that costs nothing — the visible edge asks at once, and
// nothing the owner can see was stale. A poll whose events act on the owner's
// screen while the desktop is away (the ring opening a page in a new kiosk tab)
// has to say so itself: `isBoxOwnScreen()` is the question, and `hiddenMs` as
// a function is how the answer reaches the cadence.
//
// `hiddenMs` is for a poll that delivers EVENTS which expire rather than state
// that can be re-read: the owner-notice ring keeps an entry for a minute, and a
// desktop that stopped asking for longer than that would never learn a web app
// was registered while it was away. Such a poll keeps running while hidden,
// once every `hiddenMs`, which the caller keeps inside the lifetime.

import { isMonitorSessionWindow } from "./desktop-screens";
import { kioskBarInset } from "./kiosk-bar-inset";

export interface VisibleIntervalOptions {
  /**
   * While the page is hidden, still run — once every this long, on the
   * interval's own beat (rounded up to a whole number of intervals). Absent, a
   * hidden page runs nothing until it is visible again.
   *
   * A function is asked at every hidden tick rather than once at install: the
   * answer can depend on where the page is shown (`isBoxOwnScreen()`), and the
   * kiosk bar announces itself only after the page has mounted. A value no
   * longer than the interval itself means "as if visible" — every tick runs.
   */
  hiddenMs?: number | (() => number);
}

/** A monotonic clock: the box has no RTC and its wall clock jumps at NTP sync. */
export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Is this page the box's OWN screen — where a hidden desktop is still on the
 * owner's display, a tab or a window away, rather than a phone in a pocket?
 *
 * Two places, each known by its own answer rather than by how the page is
 * displayed: the kiosk, whose bar sets its height on this page
 * (`kioskBarInset()`, 0 on every other browser), and the monitor session's
 * window, which the box itself has confirmed (`isMonitorSessionWindow()`, set
 * by `use-monitor-layout.ts` once `/setup-api/monitors` answered
 * `available: true` here). An app `display-mode` is NOT the question: the
 * desktop installed as an app on a phone or a laptop, and a tab in full
 * screen (F11, the shelf's own full-screen button), are app display modes
 * too, and treating them as the box's screen read the ring every 2 s from a
 * hidden phone — the battery cost the slower hidden cadence exists to save.
 * Read on every call, never cached: the kiosk bar and the monitors' answer
 * both arrive after the page has mounted.
 */
export function isBoxOwnScreen(): boolean {
  if (typeof window === "undefined") return false;
  if (kioskBarInset() > 0) return true;
  return isMonitorSessionWindow();
}

/**
 * `setInterval(tick, ms)` that waits while the page is hidden (see the header).
 * Returns the stop. Like `setInterval` it does not run `tick` on install — a
 * caller that asks at once does so itself.
 */
export function setVisibleInterval(tick: () => void, ms: number, options: VisibleIntervalOptions = {}): () => void {
  if (typeof document === "undefined") {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }
  const { hiddenMs } = options;
  const hidden = () => document.visibilityState === "hidden";
  let lastRun = monotonicNow();
  // A tick fell due while the page was hidden and was not run: the visible
  // edge asks for it. Only then — a page hidden and shown again within one
  // interval has missed nothing, and asking anyway would add a request.
  let missed = false;
  const run = () => {
    lastRun = monotonicNow();
    missed = false;
    tick();
  };
  const id = setInterval(() => {
    if (!hidden()) {
      run();
      return;
    }
    if (hiddenMs !== undefined) {
      const every = typeof hiddenMs === "function" ? hiddenMs() : hiddenMs;
      // On the interval's own beat: the run falls on the tick that lands
      // `every` after the last one (the next tick, for an `every` that is
      // not a whole number of beats, so it is not run sooner). Judged
      // with half a beat to spare, because a browser fires a repeating timer
      // on its schedule rather than `ms` after the last callback: a run that
      // was late stamped `lastRun` late, the tick due `every` later lands a
      // few ms short of it, and judged exactly it was skipped — every 22 s
      // for a 20 s cadence, and every other tick for one no slower than
      // visible (`beats <= 1`, which runs every tick outright).
      const beats = Math.ceil(every / ms);
      if (beats <= 1 || monotonicNow() - lastRun >= beats * ms - ms / 2) {
        run();
        return;
      }
    }
    missed = true;
  }, ms);
  // Only the visible EDGE: a request fired on the way to hidden would land in
  // a tab that has already stopped rendering.
  const onVisibility = () => {
    if (!hidden() && missed) run();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
