"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import ProgressBar from "./ProgressBar";
import WelcomeStep from "./WelcomeStep";
import CredentialsStep from "./CredentialsStep";
import WifiStep from "./WifiStep";
import UpdateStep from "./UpdateStep";
import AIModelsStep from "./AIModelsStep";
import TelegramStep from "./TelegramStep";
import DoneStep from "./DoneStep";

function applyStatusData(
  data: Record<string, unknown>,
  setSetupComplete: (v: boolean) => void,
  setCurrentStep: (v: number) => void
) {
  if (data.setup_complete) {
    setSetupComplete(true);
    setCurrentStep(7);
  } else if (data.ai_model_configured) {
    setCurrentStep(6);
  } else if (data.update_completed) {
    setCurrentStep(5);
  } else if (data.wifi_configured) {
    setCurrentStep(4);
  } else if (data.password_configured) {
    setCurrentStep(3);
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
          <p className="text-red-400 text-sm mb-4">{setupError}</p>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="bg-gray-900/80 backdrop-blur-md px-4 py-2.5 sm:px-6 sm:py-4 flex items-center justify-between gap-3 sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <span className="hidden sm:inline text-xl font-bold font-display bg-gradient-to-r from-orange-400 to-orange-700 bg-clip-text text-transparent">
            ClawBox
          </span>
        </Link>
        {currentStep < 7 && <ProgressBar currentStep={currentStep} />}
      </header>

      <main className="flex-1 flex items-start sm:items-center justify-center px-4 pt-2 pb-4 sm:p-6">
        {currentStep === 1 && (
          <WelcomeStep onNext={() => setCurrentStep(2)} />
        )}
        {currentStep === 2 && (
          <CredentialsStep onNext={() => setCurrentStep(3)} />
        )}
        {currentStep === 3 && (
          <WifiStep onNext={() => setCurrentStep(4)} />
        )}
        {currentStep === 4 && (
          <UpdateStep onNext={() => setCurrentStep(5)} />
        )}
        {currentStep === 5 && (
          <AIModelsStep onNext={() => setCurrentStep(6)} />
        )}
        {currentStep === 6 && (
          <TelegramStep onNext={() => setCurrentStep(7)} />
        )}
        {currentStep === 7 && <DoneStep setupComplete={setupComplete} />}
      </main>
    </>
  );
}
