"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { StepStatus, UpdateState } from "@/lib/updater";

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
  if (status === "skipped") {
    return (
      <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center text-gray-400 text-[10px]">
        &mdash;
      </div>
    );
  }
  return <div className="w-4 h-4 rounded-full bg-gray-600" />;
}

export default function DoneStep({ setupComplete = false }: DoneStepProps) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [completed, setCompleted] = useState(setupComplete);
  const [finishing, setFinishing] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updatePollControllerRef = useRef<AbortController | null>(null);

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
    updatePollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) return;
        const data: UpdateState = await res.json();
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase !== "running") {
          stopUpdatePolling();
        }
      } catch {
        /* ignore polling errors */
      }
    }, 2000);
  }, [stopUpdatePolling]);

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

  useEffect(() => {
    return () => stopUpdatePolling();
  }, [stopUpdatePolling]);

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

        <div className="flex items-center gap-3 flex-wrap">
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
            onClick={triggerUpdate}
            disabled={updateStarted && updateState?.phase === "running"}
            className="px-5 py-3 bg-transparent border border-orange-500/30 text-orange-400 rounded-lg text-sm font-medium hover:bg-orange-500/10 hover:border-orange-500/50 transition-colors cursor-pointer disabled:opacity-50"
          >
            {updateStarted && updateState?.phase === "running" ? "Updating..." : "System Update"}
          </button>
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="px-5 py-3 bg-transparent border border-red-500/30 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/10 hover:border-red-500/50 transition-colors cursor-pointer"
          >
            Factory Reset
          </button>
        </div>

        {/* System Update Progress */}
        {updateStarted && (
          <div className="mt-5 border border-gray-700/50 rounded-lg bg-gray-900/50 p-4">
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
              <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                {updateError}
              </div>
            )}

            {updateState && (
              <div className="space-y-0.5">
                {updateState.steps.map((step) => (
                  <div key={step.id} className="flex items-center gap-2.5 py-1.5 px-2">
                    <UpdateStepIcon status={step.status} />
                    <span
                      className={`flex-1 text-xs ${
                        step.status === "running"
                          ? "text-orange-400 font-medium"
                          : step.status === "completed"
                            ? "text-gray-400"
                            : step.status === "failed"
                              ? "text-red-400"
                              : "text-gray-600"
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {updateState?.phase === "failed" && (
              <button
                type="button"
                onClick={triggerUpdate}
                className="mt-3 px-5 py-2 btn-gradient text-white rounded-lg text-xs font-semibold cursor-pointer"
              >
                Retry Update
              </button>
            )}
          </div>
        )}
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
