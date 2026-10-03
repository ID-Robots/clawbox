"use client";

import { useEffect, useState } from "react";
import { MONITORS_IDENTIFY_EVENT, type DeskScreen, type MonitorsIdentifyDetail } from "@/lib/desktop-screens";
import { DESKTOP_LAYERS } from "@/lib/window-snap";
import { useT } from "@/lib/i18n";

/** How long Identify shows each monitor's number. */
export const IDENTIFY_MS = 4_000;

/** The ids the event numbers the monitors by, or null when it names none. */
function orderOf(event: Event): string[] | null {
  const order = (event as CustomEvent<MonitorsIdentifyDetail | null | undefined>).detail?.order;
  return Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : null;
}

/**
 * Settings → Monitors → Identify: every monitor of the row shows, for a few
 * seconds, the number the Monitors tab draws it with and its name, so "which
 * one is 2?" is answered by looking rather than guessing. The tab names its
 * own numbering in the event (`MonitorsIdentifyDetail.order` — its blocks,
 * which follow a draft not applied yet), and a monitor the tab does not number
 * shows its name alone; an event without it numbers them left to right as
 * they stand. Mounted by the desktop only while it is spread over monitors.
 */
export default function MonitorIdentifyOverlay({ screens }: { screens: DeskScreen[] }) {
  const { t } = useT();
  const [shown, setShown] = useState<{ until: number; order: string[] | null }>({ until: 0, order: null });
  useEffect(() => {
    const show = (event: Event) => setShown({ until: Date.now() + IDENTIFY_MS, order: orderOf(event) });
    window.addEventListener(MONITORS_IDENTIFY_EVENT, show);
    return () => window.removeEventListener(MONITORS_IDENTIFY_EVENT, show);
  }, []);
  const { until, order } = shown;
  useEffect(() => {
    if (!until) return;
    const timer = setTimeout(() => setShown({ until: 0, order: null }), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  if (!until) return null;
  const ordered = [...screens].sort((a, b) => a.x - b.x || a.y - b.y);
  const numberOf = (sc: DeskScreen, i: number): number | null => {
    if (!order) return i + 1;
    const at = order.indexOf(sc.id);
    return at < 0 ? null : at + 1;
  };
  return (
    <>
      {ordered.map((sc, i) => {
        const n = numberOf(sc, i);
        return (
          <div
            key={sc.id}
            data-testid="monitor-identify"
            data-monitor-id={sc.id}
            className="fixed flex items-center justify-center pointer-events-none"
            style={{ left: sc.x, top: sc.y, width: sc.width, height: sc.height, zIndex: DESKTOP_LAYERS.menu }}
          >
            <div className="flex flex-col items-center gap-3 rounded-3xl border border-white/15 bg-black/70 px-16 py-10 text-white shadow-2xl backdrop-blur-xl">
              {n !== null && <span className="font-bold leading-none" style={{ fontSize: 160 }}>{n}</span>}
              <span className="text-xl text-white/80">{sc.builtIn ? t("settings.monitors.builtIn") : sc.label}</span>
              {sc.main && <span className="rounded-full bg-[var(--coral-bright)] px-3 py-1 text-sm font-semibold text-white">{t("settings.monitors.main")}</span>}
            </div>
          </div>
        );
      })}
    </>
  );
}
