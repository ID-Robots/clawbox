"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { DEFAULT_VNC_RESOLUTION, VNC_RESOLUTIONS, isVncResolution, type VncResolution } from "@/lib/vnc-resolution";

const LABELS: Record<VncResolution, string> = {
  "1280x720": "1280 × 720 (720p)",
  "1600x900": "1600 × 900 (900p)",
  "1920x1080": "1920 × 1080 (1080p)",
};

/** Settings -> Appearance -> Display: virtual remote-desktop resolution (TASK-1479). */
export default function VncResolutionSetting() {
  const { t } = useT();
  const [value, setValue] = useState<VncResolution>(DEFAULT_VNC_RESOLUTION);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    fetch("/setup-api/vnc/resolution", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && isVncResolution(data.resolution)) setValue(data.resolution);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const onChange = async (next: string) => {
    if (!isVncResolution(next) || next === value) return;
    // Restarting the virtual display closes every window on it.
    if (!window.confirm(t("settings.vncResolutionConfirm"))) return;
    const prev = value;
    setValue(next);
    setStatus("saving");
    try {
      const res = await fetch("/setup-api/vnc/resolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: next }),
      });
      const data = res.ok ? await res.json() : null;
      if (!data || data.restartFailed) throw new Error("save failed");
      setStatus("saved");
    } catch {
      setValue(prev);
      setStatus("error");
    }
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
