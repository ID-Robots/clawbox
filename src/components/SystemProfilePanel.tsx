"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";

/**
 * Settings → System → Desktop environment + Performance mode (TASK-455).
 *
 * Two switches over two routes. They are deliberately in ONE card: both trade
 * the same thing (idle memory, idle watts) against the same thing (how much the
 * box does without being asked), and an owner reasoning about one is reasoning
 * about the other.
 *
 * Neither switch is optimistic. Both post, wait for the route to return the
 * re-read state, and render THAT — because "did the desktop actually turn off"
 * is answered by `systemctl get-default`, not by what we just asked for.
 */

interface DesktopStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  rebootRequired: boolean;
  defaultTarget: string;
  displayManager: string;
}

interface PowerLimits {
  ollama: { memoryHigh: string; memoryMax: string };
  browser: { memoryHigh: string; memoryMax: string };
  desktop: { memoryHigh: string; memoryMax: string };
  ollamaNumParallel: number;
}

interface PowerStatus {
  supported: boolean;
  mode: "balanced" | "performance";
  nvpmodelId: number | null;
  nvpmodelName: string;
  clocksPinned: boolean;
  limits?: PowerLimits;
}

function Switch({
  checked, busy, disabled, label, onChange,
}: {
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {busy && (
        <span className="material-symbols-rounded animate-spin text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">
          progress_activity
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        aria-busy={busy}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          checked ? "bg-[var(--coral-bright)]" : "bg-gray-600"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

export default function SystemProfilePanel() {
  const { t } = useT();
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [power, setPower] = useState<PowerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"desktop" | "power" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        fetch("/setup-api/system/desktop", { cache: "no-store" }),
        fetch("/setup-api/system/power-profile", { cache: "no-store" }),
      ]);
      if (d.ok) setDesktop(await d.json() as DesktopStatus);
      if (p.ok) setPower(await p.json() as PowerStatus);
      if (!d.ok && !p.ok) setError(t("systemProfile.loadFailed"));
    } catch {
      setError(t("systemProfile.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const readError = async (res: Response, fallback: string) => {
    try {
      const data = await res.json() as { error?: string };
      return typeof data.error === "string" && data.error ? data.error : fallback;
    } catch {
      return fallback;
    }
  };

  const toggleDesktop = async (next: boolean) => {
    setBusy("desktop");
    setError(null);
    try {
      const res = await fetch("/setup-api/system/desktop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(await readError(res, t("systemProfile.desktopFailed")));
      setDesktop(await res.json() as DesktopStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("systemProfile.desktopFailed"));
    } finally {
      setBusy(null);
    }
  };

  const togglePower = async (next: boolean) => {
    setBusy("power");
    setError(null);
    try {
      const res = await fetch("/setup-api/system/power-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next ? "performance" : "balanced" }),
      });
      if (!res.ok) throw new Error(await readError(res, t("systemProfile.powerFailed")));
      setPower(await res.json() as PowerStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("systemProfile.powerFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>tune</span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("systemProfile.title")}
        </label>
      </div>

      {/* Desktop environment */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)]">{t("systemProfile.desktopLabel")}</p>
          <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">
            {t("systemProfile.desktopHelp")}
          </p>
          {desktop && !desktop.supported && (
            <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1">{t("systemProfile.unsupported")}</p>
          )}
          {desktop?.rebootRequired && (
            <p className="text-[11px] text-amber-400 mt-2 flex items-center gap-1">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">restart_alt</span>
              {t("systemProfile.rebootRequired")}
            </p>
          )}
        </div>
        <Switch
          checked={desktop?.enabled ?? true}
          busy={busy === "desktop"}
          disabled={!desktop?.supported}
          label={t("systemProfile.desktopLabel")}
          onChange={toggleDesktop}
        />
      </div>

      <div className="h-px bg-white/[0.06] my-4" />

      {/* Performance mode */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)]">{t("systemProfile.performanceLabel")}</p>
          <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">
            {t("systemProfile.performanceHelp")}
          </p>
          {power && !power.supported && (
            <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1">{t("systemProfile.unsupported")}</p>
          )}
          {power?.supported && (
            <p className="text-[10px] text-[var(--text-muted)] opacity-50 mt-1 font-mono">
              {t("systemProfile.powerState", {
                profile: power.nvpmodelName,
                clocks: power.clocksPinned ? t("systemProfile.clocksPinned") : t("systemProfile.clocksDynamic"),
              })}
            </p>
          )}
        </div>
        <Switch
          checked={power?.mode === "performance"}
          busy={busy === "power"}
          disabled={!power?.supported}
          label={t("systemProfile.performanceLabel")}
          onChange={togglePower}
        />
      </div>

      {power?.limits && (
        <>
          <div className="h-px bg-white/[0.06] my-4" />
          <p className="text-[11px] text-[var(--text-muted)] opacity-60 leading-relaxed">
            {t("systemProfile.memoryGuards", {
              ollama: power.limits.ollama.memoryMax,
              browser: power.limits.browser.memoryMax,
              desktop: power.limits.desktop.memoryMax,
              parallel: String(power.limits.ollamaNumParallel),
            })}
          </p>
        </>
      )}

      {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
    </div>
  );
}
