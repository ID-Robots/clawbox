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
  saveLlamaCppConfig: (model: string, options?: { activate?: boolean }) => void;
  buttonClassName?: string;
  buttonSpinner?: ReactNode;
}
const DEFAULT_BUTTON_CLASS =
  "mt-3 px-5 py-3 btn-gradient text-[var(--set-on-primary)] rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[color-mix(in_srgb,var(--set-primary)_25%,transparent)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-2";
const DEFAULT_SPINNER = (
  <span className="inline-block w-4 h-4 border-2 border-[var(--set-on-primary)] border-t-transparent rounded-full animate-spin" />
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
    buttonLabel = canSwitchToGemma ? "Switching to Gemma 4..." : "Enabling Gemma 4...";
  } else if (canSwitchToGemma) {
    buttonLabel = "Switch to Gemma 4";
  } else {
    buttonLabel = "Enable Gemma 4";
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-[var(--set-surface-container-high)] p-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-[color-mix(in_srgb,var(--set-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--set-primary)_20%,transparent)] flex items-center justify-center shrink-0">
            <span className="material-symbols-rounded text-[var(--set-primary)]" style={{ fontSize: 24 }}>terminal</span>
          </div>
          <div>
            <div className="text-base font-semibold text-[var(--set-on-surface)]">Gemma 4</div>
            <p className="text-sm text-[var(--set-on-surface-variant)]">
              Private on-device AI for ClawBox.
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm text-[var(--set-on-surface-variant)] leading-relaxed">
          {description}
        </p>
      </div>

      {showConfiguredPill ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 px-5 py-3 rounded-lg font-semibold text-sm border border-[color-mix(in_srgb,var(--set-success)_40%,transparent)] bg-[color-mix(in_srgb,var(--set-success)_10%,transparent)] text-[var(--set-success)] flex items-center gap-2"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>check_circle</span>
          {llamaCppRunning ? "Gemma 4 is enabled and running" : "Gemma 4 is already configured"}
        </div>
      ) : (
        <button
          type="button"
          // When the model is already installed, this button's job is to make
          // it the active one — so say so to the server. Without the flag it
          // re-ran the enable flow and left the harness pointed elsewhere,
          // i.e. a "Switch to Gemma 4" button that did not switch.
          onClick={() => saveLlamaCppConfig(selectedLlamaCppModel, { activate: canSwitchToGemma })}
          disabled={!!llamaCppSaving}
          className={buttonClassName}
        >
          {llamaCppSaving && buttonSpinner}
          {buttonLabel}
        </button>
      )}

      {llamaCppSaving && llamaCppProgress && (
        <p className="text-xs text-[var(--set-on-surface-variant)] leading-relaxed">
          {llamaCppProgress}
        </p>
      )}
    </div>
  );
}
