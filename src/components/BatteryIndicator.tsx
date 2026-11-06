"use client";
import { memo, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
// Types only: erased at build, so the shelf never bundles the sysfs reader.
import type { BatteryState, BatteryStatus } from "@/lib/battery";
import { useMayUseOwnerApis } from "@/lib/use-session-user";
import { setVisibleInterval } from "@/lib/visible-interval";

/**
 * The battery in the shelf's tray: a glyph and the percentage, on a laptop
 * running the x64 edition. Everywhere else — a Jetson, a desktop with no
 * battery, a signed-out page — the route says so (`available: false`, or a
 * 401) and this renders nothing.
 *
 * The route is the owner's. Another ClawBox user's desktop does not ask at
 * all: like every owner-only desktop poll, this waits on
 * `useMayUseOwnerApis()` (src/lib/use-session-user.ts), so it sends nothing
 * the server would only refuse with a 403.
 *
 * GET /setup-api/system/battery answers a `BatteryStatus`, the type
 * `readBattery()` returns (src/lib/battery.ts owns the contract).
 */
interface Reading {
  percent: number;
  state: BatteryState;
  minutesLeft: number | null;
}

/**
 * A battery drains over hours: once a minute is plenty, and the poll waits
 * while the page is hidden (src/lib/visible-interval.ts), asking at once on
 * the way back if a tick fell due meanwhile.
 */
const POLL_MS = 60_000;

/** Discharging at or below these, the reading turns amber, then red. */
const LOW_PERCENT = 20;
const CRITICAL_PERCENT = 10;

const STATE_KEYS: Record<BatteryState, string> = {
  charging: "tray.batteryCharging",
  discharging: "tray.batteryDischarging",
  full: "tray.batteryFull",
  not_charging: "tray.batteryNotCharging",
  unknown: "tray.batteryUnknown",
};

function isState(value: unknown): value is BatteryState {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATE_KEYS, value);
}

/**
 * The reading in a reply, or null for anything that is not a battery to show:
 * `available: false`, or a body that does not keep the contract.
 */
function toReading(body: unknown): Reading | null {
  if (!body || typeof body !== "object") return null;
  const reply = body as { [K in keyof Extract<BatteryStatus, { available: true }>]?: unknown };
  if (reply.available !== true) return null;
  if (typeof reply.percent !== "number" || !Number.isFinite(reply.percent)) return null;
  const minutes = reply.minutesLeft;
  return {
    percent: Math.min(100, Math.max(0, Math.round(reply.percent))),
    state: isState(reply.state) ? reply.state : "unknown",
    minutesLeft: typeof minutes === "number" && Number.isFinite(minutes) && Math.round(minutes) > 0
      ? Math.round(minutes)
      : null,
  };
}

/**
 * The glyph for a reading. Every name is in the bundled subset
 * (public/fonts/material-symbols-rounded.ttf): the eight battery glyphs are
 * 0–6 bars of seven, then full, so a level below "full" never draws as full.
 */
function glyphFor({ state, percent }: Reading): string {
  if (state === "charging") return "battery_charging_full";
  if (state === "full") return "battery_full";
  return `battery_${Math.min(6, Math.floor((percent * 7) / 100))}_bar`;
}

const BatteryIndicator = memo(function BatteryIndicator() {
  const { t } = useT();
  // `null` until /users/me has answered; the poll starts only on `true`.
  const ownerApis = useMayUseOwnerApis() === true;
  const [reading, setReading] = useState<Reading | null>(null);

  useEffect(() => {
    if (!ownerApis) return;
    let stopped = false;
    let inFlight = false;
    // Set once the box has said there is no battery to show here (or refused
    // to say): it will not change its mind while the page is open, so the
    // poll ends for good rather than asking again every minute.
    let gone = false;
    let stopPoll = () => {};
    const giveUp = () => {
      gone = true;
      stopPoll();
      if (!stopped) setReading(null);
    };
    const refresh = async () => {
      if (gone || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/setup-api/system/battery", { cache: "no-store" });
        if (stopped) return;
        if (!res.ok) return giveUp();
        const next = toReading(await res.json());
        if (stopped) return;
        if (!next) return giveUp();
        setReading(next);
      } catch {
        // A network error or a body that is not JSON: no battery to draw,
        // and nothing for the owner to read about in the console.
        giveUp();
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    stopPoll = setVisibleInterval(() => { void refresh(); }, POLL_MS);
    // A fetch that threw before its first await gave up before there was a
    // poll to stop.
    if (gone) stopPoll();
    return () => {
      stopped = true;
      stopPoll();
    };
  }, [ownerApis]);

  if (!reading) return null;

  const { percent, state, minutesLeft } = reading;
  const discharging = state === "discharging";
  const low = discharging && percent <= LOW_PERCENT;
  const critical = discharging && percent <= CRITICAL_PERCENT;

  const parts = [t("tray.batteryTitle", { percent, state: t(STATE_KEYS[state]) })];
  if (minutesLeft !== null) {
    const time = minutesLeft >= 60
      ? t("tray.batteryHoursMinutes", { hours: Math.floor(minutesLeft / 60), minutes: minutesLeft % 60 })
      : t("tray.batteryMinutes", { minutes: minutesLeft });
    parts.push(t(state === "charging" ? "tray.batteryTimeToFull" : "tray.batteryTimeLeft", { time }));
  }
  if (low) parts.push(t("tray.batteryLow"));
  const label = parts.join(" · ");

  const tone = critical ? "text-red-400" : low ? "text-amber-400" : "text-white/80";

  return (
    <div
      role="img"
      title={label}
      aria-label={label}
      data-testid="shelf-battery"
      data-low={low ? (critical ? "critical" : "low") : undefined}
      className={`flex items-center gap-0.5 h-10 px-1.5 select-none ${tone}`}
    >
      <span
        aria-hidden="true"
        data-testid="shelf-battery-glyph"
        className={`material-symbols-rounded ${low ? "" : "text-white/60"}`}
        style={{ fontSize: 18 }}
      >
        {glyphFor(reading)}
      </span>
      <span aria-hidden="true" className="text-xs font-medium tabular-nums">{`${percent}%`}</span>
    </div>
  );
});

export default BatteryIndicator;
