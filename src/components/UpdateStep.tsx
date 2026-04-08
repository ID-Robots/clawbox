"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { StepStatus, UpdateState } from "@/lib/updater";
import { useT } from "@/lib/i18n";
import { cleanVersion } from "@/lib/version-utils";

interface UpdateStepProps {
  onNext: () => void;
}

function stepTextClass(status: StepStatus): string {
  switch (status) {
    case "running": return "text-[var(--coral-bright)] font-medium";
    case "completed": return "text-[var(--text-primary)]";
    case "failed": return "text-red-400";
    default: return "text-[var(--text-muted)]";
  }
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <div className="spinner !w-5 !h-5 !border-2" />;
  }
  if (status === "completed") {
    return (
      <div className="w-5 h-5 rounded-full bg-[#00e5cc] flex items-center justify-center text-white text-xs font-bold">
        &#10003;
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center text-white text-xs font-bold">
        &#10005;
      </div>
    );
  }
  return <div className="w-5 h-5 rounded-full bg-gray-600" />;
}

function compareVersions(a: string, b: string): number {
  const pa = (cleanVersion(a) ?? a).replace(/^v/, '').split('.').map(n => Number(n) || 0);
  const pb = (cleanVersion(b) ?? b).replace(/^v/, '').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export default function UpdateStep({ onNext }: UpdateStepProps) {
  const { t } = useT();
  const [state, setState] = useState<UpdateState | null>(null);

  const [versions, setVersions] = useState<{
    clawbox: { current: string; target: string | null };
    openclaw: { current: string | null; target: string | null };
  } | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollControllerRef.current) {
      pollControllerRef.current.abort();
      pollControllerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let consecutiveFailures = 0;
    let serverWentDown = false;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          consecutiveFailures++;
          if (consecutiveFailures >= 3) serverWentDown = true;
          return;
        }
        if (serverWentDown) {
          window.location.reload();
          return;
        }
        consecutiveFailures = 0;
        const data: UpdateState = await res.json();
        if (controller.signal.aborted) return;
        setState(data);
        if (data.phase !== "running") {
          stopPolling();
        }
      } catch {
        if (controller.signal.aborted) return;
        consecutiveFailures++;
        if (consecutiveFailures >= 3) serverWentDown = true;
      }
    }, 2000);
  }, [stopPolling]);

  // Fetch initial status (but don't auto-start)
  useEffect(() => {
    const controller = new AbortController();
    async function init() {
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data = await res.json();
        if (controller.signal.aborted) return;
        setState(data);
        if (data.versions) setVersions(data.versions);

        if (data.phase === "running") {
          startPolling();
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFetchError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    init();
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  const triggerUpdate = async () => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setStarting(true);
    setFetchError(false);
    try {
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Start update failed (${res.status})`);
      startPolling();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setFetchError(true);
      setStarting(false);
    }
  };

  useEffect(() => {
    return () => {
      actionControllerRef.current?.abort();
    };
  }, []);

  const isIdle = !state || state.phase === "idle";
  const isUpToDateEarly = !loading && isIdle && !starting && versions && !versions.clawbox.target && !versions.openclaw.target;

  // Auto-advance if already up to date — show brief flash then continue
  const autoAdvancedRef = useRef(false);
  useEffect(() => {
    if (isUpToDateEarly && !autoAdvancedRef.current) {
      autoAdvancedRef.current = true;
      const timer = setTimeout(() => onNext(), 1500);
      return () => clearTimeout(timer);
    }
  }, [isUpToDateEarly, onNext]);

  const isDone = state?.phase === "completed";
  const isFailed = state?.phase === "failed";
  const isRunning = state?.phase === "running";
  const runningStep = isRunning && state && state.currentStepIndex >= 0
    ? state.steps[state.currentStepIndex]
    : null;

  if (loading) {
    return (
      <div className="w-full max-w-[520px]" data-testid="setup-step-update">
        <div className="card-surface rounded-2xl p-8">
          <div className="flex items-center justify-center gap-2.5 p-6 text-[var(--text-secondary)] text-sm">
            <div className="spinner" /> {t("update.checkingUpdates")}
          </div>
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="w-full max-w-[520px]" data-testid="setup-step-update">
        <div className="card-surface rounded-2xl p-8">
          <h1 className="text-2xl font-bold font-display mb-2">
            {t("update.title")}
          </h1>
          <p className="text-red-400 text-sm mb-5">
            {t("update.failedToCheck")}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={triggerUpdate}
              className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
            >
              {t("retry")}
            </button>
            <button
              type="button"
              onClick={onNext}
              className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1"
            >
              {t("update.skipUpdates")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Idle state — show trigger button or "up to date"
  const isUpToDate = versions && !versions.clawbox.target && !versions.openclaw.target;

  const isDowngrade = versions?.clawbox.target
    ? compareVersions(versions.clawbox.current, versions.clawbox.target) > 0
    : false;

  if (isIdle && !starting) {
    return (
      <div className="w-full max-w-[520px]" data-testid="setup-step-update">
        <div className="card-surface rounded-2xl p-8">
          <h1 className="text-2xl font-bold font-display mb-2">
            {isUpToDate ? (
              <span className="bg-gradient-to-r from-green-400 to-emerald-500 bg-clip-text text-transparent">
                {t("update.upToDate")}
              </span>
            ) : t("update.title")}
          </h1>
          <p className="text-[var(--text-secondary)] mb-4 leading-relaxed">
            {isUpToDate
              ? t("update.latestVersion")
              : t("update.updateDescription")}
          </p>
          {versions && (
            <div className="mb-6 space-y-1.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-muted)] w-20">ClawBox</span>
                <span className={isUpToDate ? "text-green-400" : "text-[var(--text-muted)]"}>{cleanVersion(versions.clawbox.current)}</span>
                {versions.clawbox.target && (
                  <>
                    <span className="text-[var(--text-muted)]">&rarr;</span>
                    <span className="text-green-400 font-semibold">{cleanVersion(versions.clawbox.target)}</span>
                  </>
                )}
              </div>
              {versions.openclaw.current && (
                <div className="flex items-center gap-2">
                  <span className="text-[var(--text-muted)] w-20">OpenClaw</span>
                  <span className={isUpToDate ? "text-green-400" : "text-[var(--text-muted)]"}>{cleanVersion(versions.openclaw.current)}</span>
                  {versions.openclaw.target && (
                    <>
                      <span className="text-[var(--text-muted)]">&rarr;</span>
                      <span className="text-green-400 font-semibold">{cleanVersion(versions.openclaw.target)}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-3">
            {isUpToDate ? (
              <button
                type="button"
                onClick={onNext}
                className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
              >
                {t("continue")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={triggerUpdate}
                  className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
                >
                  {t("update.startUpdate")}
                </button>
                {isDowngrade && (
                  <button
                    type="button"
                    onClick={onNext}
                    className="px-6 py-3 bg-transparent border border-[var(--border-subtle)] text-[var(--text-secondary)] rounded-lg font-semibold text-sm hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  >
                    {t("skip")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Loading / waiting for first poll after triggering
  if (!state || (isIdle && starting)) {
    return (
      <div className="w-full max-w-[520px]" data-testid="setup-step-update">
        <div className="card-surface rounded-2xl p-8">
          <div className="flex items-center justify-center gap-2.5 p-6 text-[var(--text-secondary)] text-sm">
            <div className="spinner" /> {t("update.preparingUpdate")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-update">
      <div className="card-surface rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          {isDone ? (
            <span className="bg-gradient-to-r from-green-400 to-emerald-500 bg-clip-text text-transparent">
              {t("update.updateComplete")}
            </span>
          ) : (
            t("update.title")
          )}
        </h1>
        <p className="text-[var(--text-secondary)] mb-6 leading-relaxed">
          {isDone
            ? t("update.allUpdatesApplied")
            : isFailed
              ? t("update.updateError")
              : t("update.updatingDescription")}
        </p>

        {/* Internet error (no steps shown) */}
        {isFailed && state.error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            {state.error}
          </div>
        )}

        {/* Step list (hide when internet error with no steps run) */}
        {!(isFailed && state.error) && (
          <div className="my-5 space-y-1">
            {state.steps.map((step) => (
              <div
                key={step.id}
                className="flex items-center gap-3 py-2 px-3 rounded-lg"
              >
                <StepIcon status={step.status} />
                <span className={`flex-1 text-sm ${stepTextClass(step.status)}`}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Current step indicator */}
        {runningStep && (
          <div className="flex items-center gap-2.5 py-3 text-[var(--coral-bright)] text-sm">
            <div className="spinner !w-4 !h-4 !border-2" />
            {runningStep.label}...
          </div>
        )}

        {/* Failed step errors */}
        {(isDone || isFailed) && !state.error &&
          state.steps
            .filter((s) => s.status === "failed")
            .map((s) => (
              <div
                key={s.id}
                className="mt-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400"
              >
                <span className="font-semibold">{s.label}:</span>{" "}
                {s.error || "Unknown error"}
              </div>
            ))}

        {/* Action buttons */}
        {!isRunning && (
          <div className="flex items-center gap-3 mt-5">
            {isDone && (
              <button
                type="button"
                onClick={onNext}
                className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
              >
                {t("continue")}
              </button>
            )}
            {isFailed && (
              <>
                <button
                  type="button"
                  onClick={triggerUpdate}
                  className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer"
                >
                  {t("retry")}
                </button>
                <button
                  type="button"
                  onClick={onNext}
                  className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1"
                >
                  {t("update.skipUpdates")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
