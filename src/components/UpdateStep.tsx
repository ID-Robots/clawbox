"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface UpdateStepProps {
  onNext: () => void;
}

type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
type UpdatePhase = "idle" | "running" | "completed" | "failed" | "skipped";

interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  error?: string;
}

interface UpdateState {
  phase: UpdatePhase;
  steps: StepState[];
  currentStepIndex: number;
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <div className="spinner !w-5 !h-5 !border-2" />;
  }
  if (status === "completed") {
    return (
      <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-white text-xs font-bold">
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
  if (status === "skipped") {
    return (
      <div className="w-5 h-5 rounded-full bg-gray-600 flex items-center justify-center text-gray-400 text-xs">
        &mdash;
      </div>
    );
  }
  // pending
  return <div className="w-5 h-5 rounded-full bg-gray-600" />;
}

export default function UpdateStep({ onNext }: UpdateStepProps) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const startedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status");
        const data: UpdateState = await res.json();
        setState(data);
        if (data.phase !== "running") {
          stopPolling();
        }
      } catch {
        /* ignore polling errors */
      }
    }, 2000);
  }, [stopPolling]);

  useEffect(() => {
    async function init() {
      try {
        const res = await fetch("/setup-api/update/status");
        const data: UpdateState = await res.json();
        setState(data);

        if (data.phase === "completed") {
          onNext();
          return;
        }

        if (data.phase === "idle" && !startedRef.current) {
          startedRef.current = true;
          await fetch("/setup-api/update/run", { method: "POST" });
          startPolling();
        } else if (data.phase === "running") {
          startPolling();
        }
      } catch {
        setFetchError(true);
      }
    }

    init();
    return stopPolling;
  }, [onNext, startPolling, stopPolling]);

  const retry = async () => {
    startedRef.current = true;
    setFetchError(false);
    await fetch("/setup-api/update/run", { method: "POST" });
    startPolling();
  };

  if (fetchError) {
    return (
      <div className="w-full max-w-[520px]">
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
          <h1 className="text-2xl font-bold font-display mb-2">
            System Update
          </h1>
          <p className="text-red-400 text-sm mb-5">
            Failed to check update status.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={retry}
              className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer"
            >
              Retry
            </button>
            <button
              onClick={onNext}
              className="bg-transparent border-none text-orange-400 text-sm underline cursor-pointer p-1"
            >
              Skip updates
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="w-full max-w-[520px]">
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
          <div className="flex items-center justify-center gap-2.5 p-6 text-gray-400 text-sm">
            <div className="spinner" /> Preparing update...
          </div>
        </div>
      </div>
    );
  }

  const isSkipped = state.phase === "skipped";
  const isDone = state.phase === "completed";
  const isFailed = state.phase === "failed";
  const isRunning = state.phase === "running";
  const runningStep = isRunning && state.currentStepIndex >= 0
    ? state.steps[state.currentStepIndex]
    : null;

  return (
    <div className="w-full max-w-[520px]">
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          {isDone ? (
            <span className="bg-gradient-to-r from-green-400 to-emerald-500 bg-clip-text text-transparent">
              Update Complete
            </span>
          ) : isSkipped ? (
            "No Internet Connection"
          ) : (
            "System Update"
          )}
        </h1>
        <p className="text-gray-400 mb-6 leading-relaxed">
          {isDone
            ? "All updates have been applied successfully."
            : isSkipped
              ? "Updates will be applied after you connect to WiFi."
              : isFailed
                ? "The update process encountered an error."
                : "Preparing your ClawBox with the latest software..."}
        </p>

        {/* Step list */}
        <div className="my-5 space-y-1">
          {state.steps.map((step) => (
            <div
              key={step.id}
              className="flex items-center gap-3 py-2 px-3 rounded-lg"
            >
              <StepIcon status={step.status} />
              <span
                className={`flex-1 text-sm ${
                  step.status === "running"
                    ? "text-orange-400 font-medium"
                    : step.status === "completed"
                      ? "text-gray-300"
                      : step.status === "failed"
                        ? "text-red-400"
                        : step.status === "skipped"
                          ? "text-gray-600"
                          : "text-gray-500"
                }`}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>

        {/* Current step indicator */}
        {runningStep && (
          <div className="flex items-center gap-2.5 py-3 text-orange-400 text-sm">
            <div className="spinner !w-4 !h-4 !border-2" />
            {runningStep.label}...
          </div>
        )}

        {/* Failed step errors */}
        {(isDone || isFailed) &&
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
            {(isDone || isSkipped) && (
              <button
                onClick={onNext}
                className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer"
              >
                {isSkipped ? "Continue to WiFi Setup" : "Continue"}
              </button>
            )}
            {isFailed && (
              <>
                <button
                  onClick={retry}
                  className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer"
                >
                  Retry
                </button>
                <button
                  onClick={onNext}
                  className="bg-transparent border-none text-orange-400 text-sm underline cursor-pointer p-1"
                >
                  Skip updates
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
