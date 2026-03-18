"use client";

/**
 * BrowserApp — Real desktop browser integration for OpenClaw.
 * Installs Chromium if needed, configures OpenClaw computer-use,
 * and provides open/close controls for the real desktop browser.
 */

import { useEffect, useState, useCallback, useRef } from "react";

const BRAND_ORANGE = "#fe6e00";
const BRAND_ORANGE_LIGHT = "#ff8b1a";

interface BrowserStatus {
  chromium: { installed: boolean; path?: string; version?: string };
  browser: { running: boolean; pid?: number };
  enabled: boolean;
}

interface BrowserAppProps {
  onOpenApp?: (appId: string) => void;
}

export default function BrowserApp({ onOpenApp }: BrowserAppProps) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/browser/manage");
      if (!res.ok) throw new Error("Failed to fetch status");
      const data: BrowserStatus = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const doAction = useCallback(async (action: string, loadingLabel: string, successLabel?: string) => {
    setActionLoading(loadingLabel);
    setError(null);
    setSuccessMsg(null);
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
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  }, [fetchStatus]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0f1219] text-white/70 gap-4">
        <div className="w-8 h-8 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
        <p className="text-sm">Checking browser status...</p>
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
            <h1 className="text-lg font-semibold">Browser Integration</h1>
            <p className="text-xs text-white/50">Real Chromium browser for OpenClaw AI</p>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* Status messages */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <span className="material-symbols-rounded text-red-400" style={{ fontSize: 18 }}>error</span>
            <span className="text-sm text-red-400">{error}</span>
          </div>
        )}
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
              <h3 className="font-medium text-sm">Chromium Browser</h3>
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
                  Chromium is required for browser integration. Click install to set it up.
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
                    Installing...
                  </span>
                ) : "Install Chromium"}
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
              <h3 className="font-medium text-sm">OpenClaw Integration</h3>
              <p className="text-xs text-white/50 mt-1">
                {isEnabled
                  ? "Browser is connected to OpenClaw. Your AI can browse the web, fill forms, and interact with pages using a persistent profile."
                  : "Connect the browser to OpenClaw so your AI assistant can use it for web browsing, research, and automation."}
              </p>
              {isEnabled && (
                <div className="mt-2 flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: BRAND_ORANGE }} />
                    <span className="text-xs text-white/40">computer_use tool enabled</span>
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
                  {actionLoading}
                </span>
              ) : isEnabled ? "Disable" : "Enable"}
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
              <h3 className="font-medium text-sm">Desktop Browser</h3>
              <p className="text-xs text-white/50 mt-1">
                {browserRunning
                  ? "Chromium is running on the desktop. OpenClaw can interact with it in real time."
                  : "Launch a real Chromium window on the desktop that OpenClaw can control."}
              </p>
              {browserRunning && status?.browser?.pid && (
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-xs text-white/40">Running (PID {status.browser.pid})</span>
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              {browserRunning ? (
                <button
                  onClick={() => doAction("close-browser", "Closing...", "Browser closed")}
                  disabled={!!actionLoading}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {actionLoading === "Closing..." ? (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span>
                      Closing...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                      Close Browser
                    </span>
                  )}
                </button>
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
                      Opening...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
                      Open Browser
                    </span>
                  )}
                </button>
              )}
              {onOpenApp && (
                <button
                  onClick={() => onOpenApp("vnc")}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/70 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>desktop_windows</span>
                    Preview
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Info card */}
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">How it works</h3>
          <div className="space-y-3">
            <div className="flex gap-3">
              <span className="material-symbols-rounded text-white/30 shrink-0" style={{ fontSize: 18 }}>download</span>
              <p className="text-xs text-white/50"><span className="text-white/70">Install</span> — Sets up Chromium with a dedicated ClawBox profile for persistent sessions and logins.</p>
            </div>
            <div className="flex gap-3">
              <span className="material-symbols-rounded text-white/30 shrink-0" style={{ fontSize: 18 }}>link</span>
              <p className="text-xs text-white/50"><span className="text-white/70">Enable</span> — Configures OpenClaw&apos;s computer_use tool to control the browser. Your AI can navigate, click, type, and read pages.</p>
            </div>
            <div className="flex gap-3">
              <span className="material-symbols-rounded text-white/30 shrink-0" style={{ fontSize: 18 }}>desktop_windows</span>
              <p className="text-xs text-white/50"><span className="text-white/70">Open/Close</span> — Launches or stops the real Chromium window on your desktop. The browser keeps its profile between sessions.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
