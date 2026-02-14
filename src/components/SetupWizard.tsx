"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import ProgressBar from "./ProgressBar";
import WelcomeStep from "./WelcomeStep";
import UpdateStep from "./UpdateStep";
import WifiStep from "./WifiStep";
import TelegramStep from "./TelegramStep";
import DoneStep from "./DoneStep";

export default function SetupWizard() {
  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/setup-api/setup/status")
      .then((r) => {
        if (!r.ok) throw new Error(`Status check failed (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (data.setup_complete) {
          setCurrentStep(5);
        } else if (data.update_completed) {
          setCurrentStep(3);
        }
      })
      .catch((err) => {
        console.error("[SetupWizard] Failed to fetch setup status:", err);
      })
      .finally(() => setIsLoading(false));
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <>
      <header className="bg-gray-900/80 backdrop-blur-md px-6 py-4 flex items-center justify-between flex-wrap gap-3 sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <span className="text-xl font-bold font-display bg-gradient-to-r from-orange-400 to-orange-700 bg-clip-text text-transparent">
            ClawBox
          </span>
        </Link>
        {currentStep < 5 && <ProgressBar currentStep={currentStep} />}
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        {currentStep === 1 && (
          <WelcomeStep onNext={() => setCurrentStep(2)} />
        )}
        {currentStep === 2 && (
          <UpdateStep onNext={() => setCurrentStep(3)} />
        )}
        {currentStep === 3 && <WifiStep onNext={() => setCurrentStep(4)} />}
        {currentStep === 4 && (
          <TelegramStep onNext={() => setCurrentStep(5)} />
        )}
        {currentStep === 5 && <DoneStep />}
      </main>
    </>
  );
}
