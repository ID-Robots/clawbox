"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { DEFAULT_VNC_RESOLUTION, VNC_RESOLUTIONS, isVncResolution, type VncResolution } from "@/lib/vnc-resolution";

const ENDPOINT = "/setup-api/vnc/resolution";

const LABELS: Record<VncResolution, string> = {
  "1280x720": "1280 × 720 (720p)",
  "1600x900": "1600 × 900 (900p)",
  "1920x1080": "1920 × 1080 (1080p)",
};

/** The persisted resolution, or null if it could not be read. */
async function fetchSavedResolution(): Promise<VncResolution | null> {
  try {
    const res = await fetch(ENDPOINT, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return isVncResolution(data?.resolution) ? data.resolution : null;
  } catch {
    return null;
  }
}

/** Settings -> Appearance -> Display: virtual remote-desktop resolution (TASK-1479). */
export default function VncResolutionSetting() {
  const { t } = useT();
  const [value, setValue] = useState<VncResolution>(DEFAULT_VNC_RESOLUTION);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Each read or submit takes a ticket; only the latest one may set state, so
  // the mount-time read cannot overwrite a selection submitted after it began.
  const opRef = useRef(0);

  useEffect(() => {
    const op = ++opRef.current;
    let unmounted = false;
    void fetchSavedResolution().then((saved) => {
      if (saved && !unmounted && op === opRef.current) setValue(saved);
    });
    return () => { unmounted = true; };
  }, []);

  const onChange = async (next: string) => {
    if (!isVncResolution(next) || next === value) return;
    // Restarting the virtual display closes every window on it.
    if (!window.confirm(t("settings.vncResolutionConfirm"))) return;
    const op = ++opRef.current;
    const prev = value;
    setValue(next);
    setStatus("saving");
    let ok = false;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: next }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (op !== opRef.current) return;
    if (ok) {
      setStatus("saved");
      return;
    }
    // A failed restart still keeps the new value saved, so show what is stored
    // rather than assume the save was undone.
    const saved = await fetchSavedResolution();
    if (op !== opRef.current) return;
    setValue(saved ?? prev);
    setStatus("error");
  };

  return (
    <div>
      <label htmlFor="vnc-resolution" className="block text-[11px] font-medium text-white/35 uppercase tracking-wider mb-2">
        {t("settings.vncResolution")}
      </label>
      <select
        id="vnc-resolution"
        value={value}
        disabled={status === "saving"}
        onChange={(e) => void onChange(e.target.value)}
        className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)] cursor-pointer"
      >
        {VNC_RESOLUTIONS.map((r) => (
          <option key={r} value={r}>{LABELS[r]}</option>
        ))}
      </select>
      <p className="mt-1.5 text-[11px] text-white/35">
        {status === "saving"
          ? t("settings.vncResolutionApplying")
          : status === "error"
            ? t("settings.vncResolutionError")
            : t("settings.vncResolutionHint")}
      </p>
    </div>
  );
}
