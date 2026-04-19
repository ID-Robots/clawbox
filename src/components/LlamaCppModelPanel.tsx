"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";

interface LlamaCppModelPanelProps {
  llamaCppRunning: boolean;
  llamaCppInstalled: boolean;
  /**
   * Whether Gemma 4 (via llama.cpp) is the currently *active* local AI
   * provider. When Gemma is installed but another provider (e.g. Ollama)
   * is active, we still want to offer a way to switch TO Gemma — without
   * this, the panel was rendering the "already configured" pill and no
   * button, leaving users stuck on the wrong provider with nothing to
   * click.
   */
  llamaCppIsActive?: boolean;
  llamaCppSaving: string | false;
  llamaCppProgress?: string | null;
  selectedLlamaCppModel: string;
  setSelectedLlamaCppModel: (model: string) => void;
  saveLlamaCppConfig: (model: string) => void;
  buttonClassName?: string;
  buttonSpinner?: ReactNode;
}
const DEFAULT_BUTTON_CLASS =
  "mt-3 px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-2";
const DEFAULT_SPINNER = (
  <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

export default function LlamaCppModelPanel({
  llamaCppRunning,
  llamaCppInstalled,
  llamaCppIsActive = false,
  llamaCppSaving,
  llamaCppProgress,
  selectedLlamaCppModel,
  setSelectedLlamaCppModel,
  saveLlamaCppConfig,
  buttonClassName = DEFAULT_BUTTON_CLASS,
  buttonSpinner = DEFAULT_SPINNER,
}: LlamaCppModelPanelProps) {
  useEffect(() => {
    if (selectedLlamaCppModel) return;
    setSelectedLlamaCppModel(getDefaultLlamaCppModel());
  }, [selectedLlamaCppModel, setSelectedLlamaCppModel]);

  let description: string;
  if (llamaCppRunning && llamaCppIsActive) {
    description = "Gemma 4 is enabled and ready to use.";
  } else if (llamaCppInstalled && !llamaCppIsActive) {
    description = "Gemma 4 is already installed on this device. Switch to it to make it the active local AI.";
  } else if (llamaCppInstalled) {
    description = "Gemma 4 is already installed on this device. Enable it to start the local runtime and keep ClawBox working offline.";
  } else {
    description = "Enable Gemma 4 to install a local model that keeps ClawBox working even when cloud providers are unavailable.";
  }

  const showConfiguredPill = llamaCppInstalled && llamaCppIsActive && !llamaCppSaving;
  const canSwitchToGemma = llamaCppInstalled && !llamaCppIsActive;

  let buttonLabel: string;
  if (llamaCppSaving) {
    buttonLabel = "Enabling Gemma 4...";
  } else if (canSwitchToGemma) {
    buttonLabel = "Switch to Gemma 4";
  } else {
    buttonLabel = "Enable Gemma 4";
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0">
            <span className="material-symbols-rounded text-orange-300" style={{ fontSize: 24 }}>terminal</span>
          </div>
          <div>
            <div className="text-base font-semibold text-gray-100">Gemma 4</div>
            <p className="text-sm text-[var(--text-secondary)]">
              Private on-device AI for ClawBox.
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm text-[var(--text-secondary)] leading-relaxed">
          {description}
        </p>
      </div>

      {showConfiguredPill ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 px-5 py-3 rounded-lg font-semibold text-sm border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 flex items-center gap-2"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>check_circle</span>
          {llamaCppRunning ? "Gemma 4 is enabled and running" : "Gemma 4 is already configured"}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => saveLlamaCppConfig(selectedLlamaCppModel)}
          disabled={!!llamaCppSaving}
          className={buttonClassName}
        >
          {llamaCppSaving && buttonSpinner}
          {buttonLabel}
        </button>
      )}

      {llamaCppSaving && llamaCppProgress && (
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {llamaCppProgress}
        </p>
      )}
    </div>
  );
}
