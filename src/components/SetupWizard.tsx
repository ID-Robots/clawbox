"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import ProgressBar from "./ProgressBar";
import WifiStep from "./WifiStep";
import UpdateStep from "./UpdateStep";
import AIModelsStep from "./AIModelsStep";
import DoneStep from "./DoneStep";

function applyStatusData(
  data: Record<string, unknown>,
  setSetupComplete: (v: boolean) => void,
  setCurrentStep: (v: number) => void
) {
  if (data.setup_complete) {
    setSetupComplete(true);
    setCurrentStep(4);
  } else if (data.ai_model_configured) {
    setCurrentStep(4);
  } else if (data.update_completed) {
    setCurrentStep(3);
  } else if (data.wifi_configured) {
    setCurrentStep(2);
  }
}

export default function SetupWizard() {
  const [currentStep, setCurrentStep] = useState(1);
  const [setupComplete, setSetupComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetch("/setup-api/setup/status", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Status check failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) applyStatusData(data, setSetupComplete, setCurrentStep);
      })
      .catch((err) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error("[SetupWizard] Failed to fetch setup status:", err);
        setSetupError(err instanceof Error ? err.message : "Failed to load setup status");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [retryCount]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  if (setupError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <p className="text-[var(--coral-bright)] text-sm mb-4">{setupError}</p>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer transition transform hover:scale-105"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="px-4 py-2.5 sm:px-6 sm:py-4 flex items-center justify-between gap-3 sticky top-0 z-50">
        <Link href="/" className="hidden sm:flex items-center gap-2.5 shrink-0">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <span className="text-xl font-bold font-display title-gradient">
            ClawBox
          </span>
        </Link>
        {currentStep < 4 && <ProgressBar currentStep={currentStep} />}
      </header>

      <main
        className="flex-1 flex flex-col items-center justify-start sm:justify-center px-4 pt-2 pb-4 sm:p-6"
      >
        {currentStep === 1 && (
          <WifiStep onNext={() => setCurrentStep(2)} />
        )}
        {currentStep === 2 && (
          <UpdateStep onNext={() => setCurrentStep(3)} />
        )}
        {currentStep === 3 && (
          <AIModelsStep onNext={() => setCurrentStep(4)} />
        )}
        {currentStep === 4 && <DoneStep setupComplete={setupComplete} />}
      </main>
    </>
  );
}
