"use client";

/**
 * BrowserApp — Real desktop browser integration for OpenClaw.
 * Installs Chromium if needed, configures OpenClaw computer-use,
 * and provides open/close controls for the real desktop browser.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useT } from "@/lib/i18n";
import ErrorWithFix from "./ErrorWithFix";

const BRAND_ORANGE = "#fe6e00";
const BRAND_ORANGE_LIGHT = "#ff8b1a";

interface BrowserStatus {
  chromium: { installed: boolean; path?: string; version?: string };
  browser: { running: boolean; pid?: number; cdpReady?: boolean };
  enabled: boolean;
  cdpPort?: number;
}

interface BrowserAppProps {
  onOpenApp?: (appId: string) => void;
}

export default function BrowserApp({ onOpenApp }: BrowserAppProps) {
  const { t } = useT();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const actionErrorRef = useRef(false);
  const lastStatusJson = useRef("");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/browser/manage");
      if (!res.ok) throw new Error("Failed to fetch status");
      const data: BrowserStatus = await res.json();
      // Only update state if data actually changed to avoid unnecessary re-renders
      const json = JSON.stringify(data);
      if (json !== lastStatusJson.current) {
        lastStatusJson.current = json;
        setStatus(data);
      }
      if (!actionErrorRef.current) setError(null);
    } catch (err) {
      if (!actionErrorRef.current) setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  // Clear actionLoading once polling sees the requested end-state. Some
  // actions (enable/disable restart the gateway) can outlast or hang the
  // POST request — without this, the button stays stuck on "Enabling..."
  // even though the backend already reflects the new state.
  useEffect(() => {
    if (!actionLoading || !status) return;
    const enabled = status.enabled;
    const browserOn = status.browser?.running;
    if (
      (actionLoading === "Enabling..." && enabled) ||
      (actionLoading === "Disabling..." && !enabled) ||
      (actionLoading === "Opening..." && browserOn) ||
      (actionLoading === "Closing..." && !browserOn)
    ) {
      setActionLoading(null);
    }
  }, [status, actionLoading]);

  const doAction = useCallback(async (action: string, loadingLabel: string, successLabel?: string) => {
    setActionLoading(loadingLabel);
    setError(null);
    setSuccessMsg(null);
    actionErrorRef.current = false;
    try {
      const res = await fetch("/setup-api/browser/manage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      if (successLabel) {
        setSuccessMsg(successLabel);
        setTimeout(() => setSuccessMsg(null), 3000);
      }
      await fetchStatus();
    } catch (err) {
      actionErrorRef.current = true;
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  }, [fetchStatus]);

  const openVncApp = useCallback(() => {
    if (onOpenApp) {
      onOpenApp("vnc");
      return;
    }
    window.open("/app/vnc", "_blank");
  }, [onOpenApp]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0f1219] text-white/70 gap-4">
        <div className="w-8 h-8 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
        <p className="text-sm">{t("browser.checkingStatus")}</p>
      </div>
    );
  }

  const chromiumInstalled = status?.chromium?.installed ?? false;
  const browserRunning = status?.browser?.running ?? false;
  const isEnabled = status?.enabled ?? false;

  return (
    <div className="h-full flex flex-col bg-[#0f1219] text-white overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: BRAND_ORANGE }}>
            <svg className="w-6 h-6" viewBox="0 0 135.47 135.47">
              <path d="m67.733 67.733 29.33 16.933-29.33 50.8c37.408 0 67.733-30.325 67.733-67.733 0-12.341-3.3168-23.901-9.0837-33.867h-58.65z" fill="#afccf9"/>
              <path d="m67.733-1e-6c-25.07 0-46.942 13.63-58.654 33.875l29.324 50.792 29.33-16.933v-33.867h58.65c-11.714-20.24-33.583-33.867-58.65-33.867z" fill="#1767d1"/>
              <path d="m0 67.733c0 37.408 30.324 67.733 67.733 67.733l29.33-50.8-29.33-16.933-29.33 16.933-29.324-50.792c-5.7637 9.9632-9.0794 21.519-9.0794 33.858" fill="#679ef5"/>
              <path d="m101.6 67.733c0 18.704-15.163 33.867-33.867 33.867-18.704 0-33.867-15.163-33.867-33.867s15.163-33.867 33.867-33.867c18.704 0 33.867 15.163 33.867 33.867" fill="#fff"/>
              <path d="m95.25 67.733c0 15.197-12.32 27.517-27.517 27.517-15.197 0-27.517-12.32-27.517-27.517 0-15.197 12.32-27.517 27.517-27.517 15.197 0 27.517 12.32 27.517 27.517" fill="#1a74e7"/>
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold">{t("browser.title")}</h1>
            <p className="text-xs text-white/50">{t("browser.subtitle")}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* Status messages */}
        {error && <ErrorWithFix source="browser" message={error} />}
        {successMsg && (
          <div className="flex items-center gap-2 p-3 rounded-lg border" style={{ backgroundColor: `${BRAND_ORANGE}0d`, borderColor: `${BRAND_ORANGE}33` }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18, color: BRAND_ORANGE_LIGHT }}>check_circle</span>
            <span className="text-sm" style={{ color: BRAND_ORANGE_LIGHT }}>{successMsg}</span>
          </div>
        )}

        {/* Step 1: Chromium Installation */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="p-4 flex items-start gap-4">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${chromiumInstalled ? "text-white" : "bg-white/10 text-white/40"}`}
              style={chromiumInstalled ? { backgroundColor: BRAND_ORANGE } : undefined}>
              {chromiumInstalled ? (
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>check</span>
              ) : "1"}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">{t("browser.chromiumBrowser")}</h3>
              {chromiumInstalled ? (
                <div className="mt-1">
                  <p className="text-xs text-white/50">
                    {status?.chromium?.version || "Installed"}
                  </p>
                  {status?.chromium?.path && (
                    <p className="text-xs text-white/30 mt-0.5 font-mono truncate">{status.chromium.path}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-white/50 mt-1">
                  {t("browser.chromiumRequired")}
                </p>
              )}
            </div>
            {!chromiumInstalled && (
              <button
                onClick={() => doAction("install-chromium", "Installing Chromium...", "Chromium installed")}
                disabled={!!actionLoading}
                className="px-4 py-1.5 rounded-lg text-xs font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
                style={{ backgroundColor: BRAND_ORANGE }}
              >
                {actionLoading === "Installing Chromium..." ? (
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span>
                    {t("browser.installing")}
                  </span>
                ) : t("browser.installChromium")}
              </button>
            )}
          </div>
        </div>

        {/* Step 2: OpenClaw Integration */}
        <div className={`rounded-xl border overflow-hidden ${chromiumInstalled ? "border-white/10 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-50 pointer-events-none"}`}>
          <div className="p-4 flex items-start gap-4">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${isEnabled ? "text-white" : "bg-white/10 text-white/40"}`}
              style={isEnabled ? { backgroundColor: BRAND_ORANGE } : undefined}>
              {isEnabled ? (
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>check</span>
              ) : "2"}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">{t("browser.openclawIntegration")}</h3>
              <p className="text-xs text-white/50 mt-1">
                {isEnabled
                  ? t("browser.enabledMessage")
                  : t("browser.disabledMessage")}
              </p>
              {isEnabled && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: BRAND_ORANGE }} />
                    <span className="text-xs text-white/40">tools profile: full</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-rounded text-white/30" style={{ fontSize: 14 }}>bug_report</span>
                    <span className="text-xs text-white/30 font-mono">CDP port {status?.cdpPort ?? 18800}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-rounded text-white/30" style={{ fontSize: 14 }}>folder</span>
                    <span className="text-xs text-white/30 font-mono">~/.config/clawbox-browser/</span>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => isEnabled
                ? doAction("disable", "Disabling...", "Browser disconnected from OpenClaw")
                : doAction("enable", "Enabling...", "Browser connected to OpenClaw")
              }
              disabled={!!actionLoading}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${
                isEnabled ? "bg-white/10 text-white/60 hover:bg-white/15" : "text-white"
              }`}
              style={!isEnabled ? { backgroundColor: BRAND_ORANGE } : undefined}
            >
              {actionLoading === "Enabling..." || actionLoading === "Disabling..." ? (
                <span className="flex items-center gap-1.5">
                  <span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span>
                  {actionLoading === "Enabling..." ? t("browser.enabling") : t("browser.disabling")}
                </span>
              ) : isEnabled ? t("browser.disable") : t("browser.enable")}
            </button>
          </div>
        </div>

        {/* Step 3: Browser Controls */}
        <div className={`rounded-xl border overflow-hidden ${isEnabled ? "border-white/10 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-50 pointer-events-none"}`}>
          <div className="p-4 flex items-start gap-4">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${browserRunning ? "text-white" : "bg-white/10 text-white/40"}`}
              style={browserRunning ? { backgroundColor: BRAND_ORANGE } : undefined}>
              {browserRunning ? (
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>check</span>
              ) : "3"}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">{t("browser.desktopBrowser")}</h3>
              <p className="text-xs text-white/50 mt-1">
                {browserRunning
                  ? t("browser.runningMessage")
                  : t("browser.launchMessage")}
              </p>
              {browserRunning && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-xs text-white/40">PID {status?.browser?.pid ?? "?"}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${status?.browser?.cdpReady ? "bg-green-400" : "bg-yellow-400"}`} />
                    <span className="text-xs text-white/40 font-mono">
                      CDP :{status?.cdpPort ?? 18800} {status?.browser?.cdpReady ? t("browser.ready") : t("browser.starting")}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={openVncApp}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/80 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>desktop_windows</span>
                  {t("browser.openInVNC")}
                </span>
              </button>
              {browserRunning ? (
                <>
                  <button
                    onClick={() => doAction("close-browser", "Closing...", "Browser closed")}
                    disabled={!!actionLoading}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {actionLoading === "Closing..." ? (
                      <span className="flex items-center gap-1.5">
                        <span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span>
                        {t("browser.closing")}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                        {t("browser.closeBrowser")}
                      </span>
                    )}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => doAction("open-browser", "Opening...", "Browser launched")}
                  disabled={!!actionLoading}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
                  style={{ backgroundColor: BRAND_ORANGE }}
                >
                  {actionLoading === "Opening..." ? (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span>
                      {t("browser.opening")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
                      {t("browser.openBrowser")}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
