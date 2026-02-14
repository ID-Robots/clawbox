"use client";

import { useState, useEffect, useRef, useCallback } from "react";

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

export default function DoneStep() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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

  const closeResetModal = useCallback(() => {
    setShowResetConfirm(false);
    setResetting(false);
    setResetError(null);
  }, []);

  // Escape key handler for modal
  useEffect(() => {
    if (!showResetConfirm) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeResetModal();
    };
    document.addEventListener("keydown", handleKey);
    modalRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [showResetConfirm, closeResetModal]);

  const completeSetup = async () => {
    setFinishing(true);
    setCompleteError(null);
    try {
      const res = await fetch("/setup-api/setup/complete", { method: "POST" });
      if (res.ok) {
        setCompleted(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setCompleteError(data.error || "Failed to complete setup");
      }
    } catch (err) {
      setCompleteError(err instanceof Error ? err.message : "Failed to complete setup");
    } finally {
      setFinishing(false);
    }
  };

  const infoItems = info
    ? [
        { label: "CPUs", value: String(info.cpus) },
        {
          label: "Memory",
          value: `${info.memoryFree} free / ${info.memoryTotal}`,
        },
        {
          label: "NVMe Storage",
          value: `${info.diskFree} free / ${info.diskTotal}`,
        },
        { label: "Temperature", value: info.temperature },
        { label: "Uptime", value: info.uptime },
      ]
    : [];

  return (
    <div className="w-full max-w-[520px]">
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <div className="my-5">
          {!info && !loadError && (
            <div className="flex items-center justify-center gap-2.5 p-6 text-gray-400 text-sm">
              <div className="spinner" /> Loading system info...
            </div>
          )}
          {loadError && (
            <div className="p-6 text-center text-red-400 text-sm">
              Failed to load system info
            </div>
          )}
          {info &&
            infoItems.map(({ label, value }) => (
              <div
                key={label}
                className="flex justify-between py-2.5 border-b border-gray-700/50 last:border-b-0 text-sm"
              >
                <span className="text-gray-500 font-medium">{label}</span>
                <span className="font-semibold text-gray-200 text-right">
                  {value}
                </span>
              </div>
            ))}
        </div>

        {completeError && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
            {completeError}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={completed ? () => (window.location.href = "/") : completeSetup}
            disabled={finishing}
            className={`px-8 py-3 rounded-lg text-sm font-semibold transition transform cursor-pointer ${
              completed
                ? "bg-gray-700 text-gray-300 border border-gray-600 hover:bg-gray-600"
                : "btn-gradient text-white hover:scale-105 shadow-lg shadow-orange-500/25 disabled:opacity-50 disabled:hover:scale-100"
            }`}
          >
            {finishing ? "Finishing..." : completed ? "Open Control Panel" : "Finish Setup"}
          </button>
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="px-5 py-3 bg-transparent border border-red-500/30 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/10 hover:border-red-500/50 transition-colors cursor-pointer"
          >
            Factory Reset
          </button>
        </div>
      </div>

      {/* Factory reset confirmation modal */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 flex items-center justify-center z-[100] p-6"
        >
          <div className="fixed inset-0 bg-black/60" aria-hidden="true" role="presentation" />
          <div
            className="relative z-[101] w-full max-w-[400px] bg-gray-800 border border-gray-700 rounded-2xl p-8 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            ref={modalRef}
            tabIndex={-1}
          >
            <h2 id="reset-dialog-title" className="text-lg font-semibold font-display mb-2 text-red-400">
              Factory Reset
            </h2>
            <p className="text-gray-400 text-sm leading-relaxed mb-5">
              This will erase all settings (WiFi, Telegram, etc.) and restart the setup wizard. This action cannot be undone.
            </p>
            {resetError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                {resetError}
              </div>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={async () => {
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
                    window.location.href = "/setup";
                  } catch (err) {
                    setResetting(false);
                    setResetError(err instanceof Error ? err.message : "Reset failed");
                  }
                }}
                disabled={resetting}
                className="px-7 py-3 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-500 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {resetting ? "Resetting..." : "Yes, Reset Everything"}
              </button>
              <button
                type="button"
                onClick={closeResetModal}
                className="px-5 py-2.5 bg-gray-700 text-gray-300 border border-gray-600 rounded-lg text-sm font-medium hover:bg-gray-600 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
