"use client";

import { useEffect } from "react";
import { MONITORS_CHANGED_EVENT, screensFromStatus, setDeskScreens, type MonitorStatusLike } from "./desktop-screens";

/** How often the desktop re-reads the monitors while a monitor session answers. */
export const MONITOR_POLL_MS = 5_000;
/** How soon after a resize or a layout change it reads them again. */
export const MONITOR_SOON_MS = 200;

/**
 * Keeps `desktop-screens` in step with the monitors the desktop window is
 * spread over (monitor mode, src/lib/monitors.ts).
 *
 * Only in the desktop's APP window — the one the monitor session lays over
 * every monitor, whose `display-mode` is never `browser`. A desktop opened in
 * a browser tab (a phone, a laptop on the LAN, every Jetson) asks nothing at
 * all. In the app window it asks once; a box with no monitor session answers
 * `available: false` and nothing more is asked until the window is resized.
 * With one, it re-reads every few seconds (a monitor plugged in reaches the
 * page within one tick), on every resize, and at once when the Settings tab
 * changed the layout.
 *
 * ONE read at a time: an event that arrives while a read is in flight asks
 * for another read once it is done, rather than starting a second timer — the
 * second timer used to be dropped by the next tick without being cleared, and
 * every such event left one more chain polling for the life of the page.
 *
 * And once a monitor session HAS answered, this page is its window: an
 * `available: false` (or a 5xx) after that is a read that failed — wlr-randr
 * timing out, a dock unplugged for a moment — not a box without monitors. The
 * layout the page has stands and it keeps asking; stopping there left the
 * page laid out as one screen across every monitor until something happened
 * to resize the window.
 */
export function useMonitorLayoutSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: browser)").matches) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;
    let readAgain = false;
    let seen = false;

    const read = async (): Promise<"on" | "off" | "error"> => {
      try {
        const res = await fetch("/setup-api/monitors", { cache: "no-store" });
        if (!res.ok) return seen && res.status >= 500 ? "error" : "off";
        const status = (await res.json()) as MonitorStatusLike;
        if (!live) return "off";
        if (!status.available) {
          if (seen) return "error";
          setDeskScreens(null);
          return "off";
        }
        seen = true;
        setDeskScreens(screensFromStatus(status, window.innerWidth, window.innerHeight));
        return "on";
      } catch {
        return "error";
      }
    };

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, ms);
    };

    const tick = async () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      const result = await read();
      reading = false;
      if (!live) return;
      // Something changed while that read was out: its answer may predate it.
      if (readAgain) {
        readAgain = false;
        schedule(MONITOR_SOON_MS);
        return;
      }
      if (result !== "off") schedule(MONITOR_POLL_MS);
    };

    const soon = () => {
      if (reading) readAgain = true;
      else schedule(MONITOR_SOON_MS);
    };

    void tick();
    window.addEventListener("resize", soon);
    window.addEventListener(MONITORS_CHANGED_EVENT, soon);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", soon);
      window.removeEventListener(MONITORS_CHANGED_EVENT, soon);
      setDeskScreens(null);
    };
  }, [enabled]);
}
