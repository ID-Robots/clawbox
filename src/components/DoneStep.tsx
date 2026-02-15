"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { StepStatus, UpdateState } from "@/lib/updater";
import StatusMessage from "./StatusMessage";

interface SystemInfo {
  cpus: number;
  memoryTotal: string;
  memoryFree: string;
  temperature: string;
  uptime: string;
  diskUsed: string;
  diskFree: string;
  diskTotal: string;
}

interface DoneStepProps {
  setupComplete?: boolean;
}

/* ── Shared eye icons ── */
const EyeOpen = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
);
const EyeClosed = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
);

/* ── Chevron for collapsible sections ── */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* ── Update step helpers ── */
function updateStepTextClass(status: StepStatus): string {
  switch (status) {
    case "running": return "text-orange-400 font-medium";
    case "completed": return "text-gray-400";
    case "failed": return "text-red-400";
    default: return "text-gray-600";
  }
}

function UpdateStepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <div className="spinner !w-4 !h-4 !border-2" />;
  }
  if (status === "completed") {
    return (
      <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-white text-[10px] font-bold">
        &#10003;
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white text-[10px] font-bold">
        &#10005;
      </div>
    );
  }
  return <div className="w-4 h-4 rounded-full bg-gray-600" />;
}

export default function DoneStep({ setupComplete = false }: DoneStepProps) {
  /* ── System info ── */
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState(false);

  /* ── Finish / reset ── */
  const [finishing, setFinishing] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetInProgress, setResetInProgress] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  /* ── System update ── */
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updatePollControllerRef = useRef<AbortController | null>(null);

  /* ── Collapsible sections ── */
  const [openSection, setOpenSection] = useState<string | null>(null);
  const toggle = (id: string) => setOpenSection((prev) => (prev === id ? null : id));

  /* ── Security (system password + hotspot) ── */
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
  const [secSaving, setSecSaving] = useState(false);
  const [secStatus, setSecStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  /* ── Telegram ── */
  const [botToken, setBotToken] = useState("");
  const [showBotToken, setShowBotToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgStatus, setTgStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  /* ── Fetch system info on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/info", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      })
      .then(setInfo)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(true);
      });
    return () => controller.abort();
  }, []);

  /* ── Fetch hotspot defaults on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hotspot", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted && data.ssid) {
          setHotspotName(data.ssid);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Update polling ── */
  const stopUpdatePolling = useCallback(() => {
    if (updatePollRef.current) {
      clearInterval(updatePollRef.current);
      updatePollRef.current = null;
    }
    updatePollControllerRef.current?.abort();
    updatePollControllerRef.current = null;
  }, []);

  const startUpdatePolling = useCallback(() => {
    if (updatePollRef.current) return;
    const controller = new AbortController();
    updatePollControllerRef.current = controller;
    let failureCount = 0;
    let serverWentDown = false;
    updatePollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          failureCount++;
          if (failureCount >= 3) serverWentDown = true;
          return;
        }
        if (serverWentDown) {
          window.location.reload();
          return;
        }
        failureCount = 0;
        const data: UpdateState = await res.json();
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase !== "running") stopUpdatePolling();
      } catch {
        if (controller.signal.aborted) return;
        failureCount++;
        if (failureCount >= 3) serverWentDown = true;
      }
    }, 2000);
  }, [stopUpdatePolling]);

  useEffect(() => () => stopUpdatePolling(), [stopUpdatePolling]);

  const triggerUpdate = async () => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(typeof data.error === "string" ? data.error : "Failed to start update");
        return;
      }
      startUpdatePolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Failed to start update");
    }
  };

  /* ── Finish setup ── */
  const completeSetup = async () => {
    setFinishing(true);
    setCompleteError(null);
    try {
      const res = await fetch("/setup-api/setup/complete", {
        method: "POST",
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setCompleteError(data.error || "Failed to complete setup");
    } catch (err) {
      setCompleteError(
        err instanceof Error ? err.message : "Failed to complete setup"
      );
    } finally {
      setFinishing(false);
    }
  };

  /* ── Factory reset ── */
  const closeResetModal = useCallback(() => {
    setShowResetConfirm(false);
    setResetting(false);
    setResetError(null);
  }, []);

  useEffect(() => {
    if (!showResetConfirm) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeResetModal();
    };
    document.addEventListener("keydown", handleKey);
    modalRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [showResetConfirm, closeResetModal]);

  const handleFactoryReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      const res = await fetch("/setup-api/setup/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Reset failed");
      }
      setResetInProgress(true);
      setShowResetConfirm(false);
      const pollUntilReady = async () => {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          try {
            const check = await fetch("/setup-api/setup/status", {
              signal: AbortSignal.timeout(5000),
            });
            if (check.ok) {
              window.location.href = "/setup";
              return;
            }
          } catch {
            // Server still restarting, keep polling
          }
        }
      };
      pollUntilReady();
    } catch (err) {
      setResetting(false);
      setResetError(err instanceof Error ? err.message : "Reset failed");
    }
  };

  /* ── Save security settings ── */
  const saveSecurity = async () => {
    if (password || confirmPassword) {
      if (password.length < 8) {
        setSecStatus({ type: "error", message: "Password must be at least 8 characters" });
        return;
      }
      if (password !== confirmPassword) {
        setSecStatus({ type: "error", message: "Passwords do not match" });
        return;
      }
    }
    if (!hotspotName.trim()) {
      setSecStatus({ type: "error", message: "Hotspot name is required" });
      return;
    }
    if (hotspotPassword && hotspotPassword.length < 8) {
      setSecStatus({ type: "error", message: "Hotspot password must be at least 8 characters" });
      return;
    }

    setSecSaving(true);
    setSecStatus(null);
    try {
      if (password) {
        const res = await fetch("/setup-api/system/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setSecStatus({
            type: "error",
            message: data.error || "Failed to set password",
          });
          return;
        }
      }
      const hotspotRes = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: hotspotName.trim(),
          password: hotspotPassword || undefined,
        }),
      });
      if (!hotspotRes.ok) {
        const data = await hotspotRes.json().catch(() => ({}));
        setSecStatus({
          type: "error",
          message: data.error || "Failed to save hotspot settings",
        });
        return;
      }
      setSecStatus({ type: "success", message: "Settings saved!" });
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setSecStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setSecSaving(false);
    }
  };

  /* ── Save telegram ── */
  const saveTelegram = async () => {
    if (!botToken.trim()) {
      setTgStatus({ type: "error", message: "Please enter a bot token" });
      return;
    }
    setTgSaving(true);
    setTgStatus(null);
    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTgStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }
      const data = await res.json();
      if (data.success) {
        setTgStatus({ type: "success", message: "Telegram bot configured!" });
      } else {
        setTgStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
      }
    } catch (err) {
      setTgStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setTgSaving(false);
    }
  };

  /* ── System info items ── */
  const infoItems = info
    ? [
        { label: "CPUs", value: String(info.cpus) },
        { label: "Memory", value: `${info.memoryFree} free / ${info.memoryTotal}` },
        { label: "NVMe Storage", value: `${info.diskFree} free / ${info.diskTotal}` },
        { label: "Temperature", value: info.temperature },
        { label: "Uptime", value: info.uptime },
      ]
    : [];

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Page heading */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-display text-gray-100">Administration</h1>
        <p className="text-gray-500 text-sm mt-1">Device settings and management</p>
      </div>

      {completeError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{completeError}</div>
      )}

      {/* Primary actions */}
      <div className="flex items-center gap-3 flex-wrap mb-6">
        <button
          type="button"
          onClick={setupComplete ? () => (window.location.href = "/") : completeSetup}
          disabled={finishing}
          className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition transform cursor-pointer ${
            setupComplete
              ? "bg-gray-700 text-gray-300 border border-gray-600 hover:bg-gray-600"
              : "btn-gradient text-white hover:scale-105 shadow-lg shadow-orange-500/25 disabled:opacity-50 disabled:hover:scale-100"
          }`}
        >
          {finishing ? "Finishing..." : setupComplete ? "OpenClaw" : "Finish Setup"}
        </button>
        <button
          type="button"
          onClick={triggerUpdate}
          disabled={updateStarted && updateState?.phase === "running"}
          className="px-5 py-2.5 bg-transparent border border-orange-500/30 text-orange-400 rounded-lg text-sm font-medium hover:bg-orange-500/10 hover:border-orange-500/50 transition-colors cursor-pointer disabled:opacity-50"
        >
          {updateStarted && updateState?.phase === "running" ? "Updating..." : "System Update"}
        </button>
      </div>

      {/* System Update Progress */}
      {updateStarted && (
        <div className="mb-4 bg-gray-800/50 border border-gray-700/50 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3">
            {updateState?.phase === "completed" ? (
              <span className="text-green-400">Update Complete</span>
            ) : updateState?.phase === "failed" ? (
              <span className="text-red-400">Update Failed</span>
            ) : (
              "System Update"
            )}
          </h3>
          {updateError && (
            <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{updateError}</div>
          )}
          {updateState && (
            <div className="space-y-0.5">
              {updateState.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2.5 py-1.5 px-2">
                  <UpdateStepIcon status={step.status} />
                  <span className={`flex-1 text-xs ${updateStepTextClass(step.status)}`}>{step.label}</span>
                </div>
              ))}
            </div>
          )}
          {updateState?.phase === "failed" && (
            <button type="button" onClick={triggerUpdate} className="mt-3 px-5 py-2 btn-gradient text-white rounded-lg text-xs font-semibold cursor-pointer">Retry Update</button>
          )}
        </div>
      )}

      {/* Settings sections */}
      <div className="space-y-3">
        {/* System Info */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => toggle("sysinfo")}
            className="flex items-center gap-2.5 w-full py-3.5 px-5 text-sm font-medium text-gray-300 hover:text-gray-100 hover:bg-gray-700/30 bg-transparent border-none cursor-pointer text-left transition-colors"
          >
            <Chevron open={openSection === "sysinfo"} />
            System Info
          </button>
          {openSection === "sysinfo" && (
            <div className="px-5 pb-4 border-t border-gray-700/30">
              {!info && !loadError && (
                <div className="flex items-center justify-center gap-2.5 py-4 text-gray-400 text-sm">
                  <div className="spinner" /> Loading...
                </div>
              )}
              {loadError && <div className="py-3 text-center text-red-400 text-sm">Failed to load system info</div>}
              {info && infoItems.map(({ label, value }) => (
                <div key={label} className="flex justify-between py-2.5 border-b border-gray-700/30 last:border-b-0 text-sm">
                  <span className="text-gray-500 font-medium">{label}</span>
                  <span className="font-semibold text-gray-200 text-right">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Security */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => toggle("security")}
            className="flex items-center gap-2.5 w-full py-3.5 px-5 text-sm font-medium text-gray-300 hover:text-gray-100 hover:bg-gray-700/30 bg-transparent border-none cursor-pointer text-left transition-colors"
          >
            <Chevron open={openSection === "security"} />
            Security
          </button>
          {openSection === "security" && (
            <div className="px-5 pb-5 border-t border-gray-700/30 pt-4 space-y-4">
              <p className="text-xs text-gray-500">Set system password and configure hotspot for next setup.</p>
              <div>
                <label htmlFor="sec-pw" className="block text-xs font-semibold text-gray-400 mb-1.5">New Password</label>
                <div className="relative">
                  <input id="sec-pw" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimum 8 characters" autoComplete="new-password" className="w-full px-3.5 py-2.5 pr-10 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500" />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide" : "Show"} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 bg-transparent border-none cursor-pointer p-0.5">{showPassword ? EyeClosed : EyeOpen}</button>
                </div>
              </div>
              <div>
                <label htmlFor="sec-pw2" className="block text-xs font-semibold text-gray-400 mb-1.5">Confirm Password</label>
                <div className="relative">
                  <input id="sec-pw2" type={showConfirm ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" className="w-full px-3.5 py-2.5 pr-10 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500" />
                  <button type="button" onClick={() => setShowConfirm((v) => !v)} aria-label={showConfirm ? "Hide" : "Show"} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 bg-transparent border-none cursor-pointer p-0.5">{showConfirm ? EyeClosed : EyeOpen}</button>
                </div>
              </div>
              <div className="border-t border-gray-700/50 pt-3">
                <label htmlFor="hs-name" className="block text-xs font-semibold text-gray-400 mb-1.5">Hotspot Name</label>
                <input id="hs-name" type="text" value={hotspotName} onChange={(e) => setHotspotName(e.target.value)} maxLength={32} className="w-full px-3.5 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500" />
              </div>
              <div>
                <label htmlFor="hs-pw" className="block text-xs font-semibold text-gray-400 mb-1.5">Hotspot Password <span className="text-gray-500 font-normal">(optional)</span></label>
                <div className="relative">
                  <input id="hs-pw" type={showHotspotPassword ? "text" : "password"} value={hotspotPassword} onChange={(e) => setHotspotPassword(e.target.value)} placeholder="Leave empty for open network" className="w-full px-3.5 py-2.5 pr-10 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500" />
                  <button type="button" onClick={() => setShowHotspotPassword((v) => !v)} aria-label={showHotspotPassword ? "Hide" : "Show"} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 bg-transparent border-none cursor-pointer p-0.5">{showHotspotPassword ? EyeClosed : EyeOpen}</button>
                </div>
              </div>
              {secStatus && <StatusMessage type={secStatus.type} message={secStatus.message} />}
              <button type="button" onClick={saveSecurity} disabled={secSaving} className="px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50">{secSaving ? "Saving..." : "Save"}</button>
            </div>
          )}
        </div>

        {/* Telegram */}
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => toggle("telegram")}
            className="flex items-center gap-2.5 w-full py-3.5 px-5 text-sm font-medium text-gray-300 hover:text-gray-100 hover:bg-gray-700/30 bg-transparent border-none cursor-pointer text-left transition-colors"
          >
            <Chevron open={openSection === "telegram"} />
            Telegram Bot
          </button>
          {openSection === "telegram" && (
            <div className="px-5 pb-5 border-t border-gray-700/30 pt-4 space-y-4">
              <div className="flex gap-4 items-start">
                <div className="shrink-0 p-1.5 bg-white rounded-lg">
                  <QRCodeSVG value="https://t.me/BotFather" size={80} level="M" bgColor="#ffffff" fgColor="#000000" />
                </div>
                <ol className="ml-0 pl-4 leading-[1.7] text-xs text-gray-300 list-decimal">
                  <li>Scan QR or search <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:text-orange-300 font-semibold">@BotFather</a></li>
                  <li>Send <code className="bg-gray-700 px-1 py-0.5 rounded text-[11px] text-orange-400">/newbot</code></li>
                  <li>Paste the <strong>Bot Token</strong> below</li>
                </ol>
              </div>
              <div>
                <label htmlFor="tg-token" className="block text-xs font-semibold text-gray-400 mb-1.5">Bot Token</label>
                <div className="relative">
                  <input id="tg-token" type={showBotToken ? "text" : "password"} value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456789:ABCdefGHI..." spellCheck={false} autoComplete="off" className="w-full px-3.5 py-2.5 pr-10 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500" />
                  <button type="button" onClick={() => setShowBotToken((v) => !v)} aria-label={showBotToken ? "Hide" : "Show"} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 bg-transparent border-none cursor-pointer p-0.5">{showBotToken ? EyeClosed : EyeOpen}</button>
                </div>
              </div>
              {tgStatus && <StatusMessage type={tgStatus.type} message={tgStatus.message} />}
              <button type="button" onClick={saveTelegram} disabled={tgSaving} className="px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50">{tgSaving ? "Saving..." : "Save"}</button>
            </div>
          )}
        </div>

        {/* Danger Zone */}
        <div className="bg-gray-800/30 border border-red-500/20 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => toggle("danger")}
            className="flex items-center gap-2.5 w-full py-3.5 px-5 text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/5 bg-transparent border-none cursor-pointer text-left transition-colors"
          >
            <Chevron open={openSection === "danger"} />
            Danger Zone
          </button>
          {openSection === "danger" && (
            <div className="px-5 pb-5 border-t border-red-500/10 pt-4">
              <p className="text-xs text-gray-400 mb-3">Erase all settings and restart the setup wizard. This action cannot be undone.</p>
              <button
                type="button"
                onClick={() => setShowResetConfirm(true)}
                className="px-5 py-2.5 bg-red-600/80 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors cursor-pointer"
              >
                Factory Reset
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Factory reset in progress overlay */}
      {resetInProgress && (
        <div className="fixed inset-0 flex flex-col items-center justify-center z-[100] bg-gray-900">
          <div className="spinner !w-10 !h-10 !border-3 mb-6" />
          <h2 className="text-xl font-semibold font-display text-gray-200 mb-2">Factory Reset in Progress</h2>
          <p className="text-gray-400 text-sm text-center max-w-xs">Cleaning up and reinstalling. This may take a few minutes. The page will reload automatically.</p>
        </div>
      )}

      {/* Factory reset confirmation modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] p-6">
          <div className="fixed inset-0 bg-black/60" aria-hidden="true" role="presentation" />
          <div
            className="relative z-[101] w-full max-w-[400px] bg-gray-800 border border-gray-700 rounded-2xl p-8 shadow-2xl"
            role="dialog" aria-modal="true" aria-labelledby="reset-dialog-title" ref={modalRef} tabIndex={-1}
          >
            <h2 id="reset-dialog-title" className="text-lg font-semibold font-display mb-2 text-red-400">Factory Reset</h2>
            <p className="text-gray-400 text-sm leading-relaxed mb-5">This will erase all settings and restart the setup wizard. This action cannot be undone.</p>
            {resetError && <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{resetError}</div>}
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleFactoryReset} disabled={resetting} className="px-7 py-3 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-500 transition-colors disabled:opacity-50 cursor-pointer">{resetting ? "Resetting..." : "Yes, Reset Everything"}</button>
              <button type="button" onClick={closeResetModal} className="px-5 py-2.5 bg-gray-700 text-gray-300 border border-gray-600 rounded-lg text-sm font-medium hover:bg-gray-600 transition-colors cursor-pointer">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
