"use client";

/**
 * Settings → Update: the switch for the weekly update check (TASK-2260,
 * src/lib/update-notice.ts). On by default; the box reads it when Monday's
 * slot fires, so turning it off here is enough on its own.
 *
 * It says when the box looks next and the last version it told the owner
 * about, because "is this on, and did it ever do anything" is the question a
 * switch like this gets.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { CARD } from "@/components/UpdateRunView";

/** GET/POST /setup-api/update/weekly-check (the route keeps its own copy of this shape). */
interface WeeklyUpdateCheckInfo {
  enabled: boolean;
  nextCheckAt: number | null;
  lastNotified: { version: string; at: number; via: "telegram" | "desktop" | null } | null;
}

const ENDPOINT = "/setup-api/update/weekly-check";

function isInfo(value: unknown): value is WeeklyUpdateCheckInfo {
  return typeof value === "object" && value !== null && typeof (value as { enabled?: unknown }).enabled === "boolean";
}

export default function WeeklyUpdateCheckCard() {
  const { locale } = useT();
  const tr = useTr();
  const labelId = useId();
  const [info, setInfo] = useState<WeeklyUpdateCheckInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(ENDPOINT, { cache: "no-store" });
        const data: unknown = res.ok ? await res.json() : null;
        if (live && isInfo(data)) setInfo(data);
      } catch {
        /* The card stays hidden rather than showing a switch in a state it does not know. */
      }
    })();
    return () => { live = false; };
  }, []);

  const save = useCallback(async (enabled: boolean) => {
    setSaving(true);
    setError(false);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok || !isInfo(data)) throw new Error(`HTTP ${res.status}`);
      setInfo(data);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }, []);

  if (!info) return null;

  const when = (ms: number) => new Date(ms).toLocaleString(locale, {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  const day = (ms: number) => new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className={CARD} data-testid="weekly-update-check">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div id={labelId} className="text-sm font-semibold text-gray-100 inline-flex items-center gap-2">
            <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 18 }} aria-hidden="true">event_repeat</span>
            {tr("updateNotice.title", "Weekly update check")}
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {tr(
              "updateNotice.helper",
              "Every Monday around 10:00 (this box's time), ClawBox looks for a newer version on the branch it follows and tells you once per version — in Telegram with an Update button, or on this desktop when no Telegram bot is connected. You can also send /update to the bot at any time.",
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={info.enabled}
          aria-label={tr("updateNotice.switch", "Check for updates every week")}
          aria-describedby={labelId}
          disabled={saving}
          onClick={() => void save(!info.enabled)}
          data-testid="weekly-update-check-switch"
          className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${info.enabled ? "bg-emerald-500" : "bg-white/15"} ${saving ? "opacity-50" : ""}`}
        >
          <span
            className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
            style={{ left: 2, transform: info.enabled ? "translateX(18px)" : "translateX(0)" }}
          />
        </button>
      </div>
      <div className="mt-2 space-y-1 text-xs text-[var(--text-muted)]" data-testid="weekly-update-check-status">
        {info.enabled
          ? info.nextCheckAt && <p>{tr("updateNotice.next", "Next check: {time}", { time: when(info.nextCheckAt) })}</p>
          : <p>{tr("updateNotice.off", "Off: the box does not look for updates on its own.")}</p>}
        {info.lastNotified && (
          <p>
            {tr("updateNotice.lastNotified", "Last told you about {version} on {date}.", {
              version: info.lastNotified.version,
              date: day(info.lastNotified.at),
            })}
          </p>
        )}
        {error && (
          <p className="text-red-300" role="alert">
            {tr("updateNotice.saveFailed", "The setting could not be saved. Try again.")}
          </p>
        )}
      </div>
    </div>
  );
}
