"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";

interface LlamaCppModelPanelProps {
  llamaCppRunning: boolean;
  llamaCppInstalled: boolean;
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
          {llamaCppRunning
            ? "Gemma 4 is enabled and ready to use."
            : llamaCppInstalled
              ? "Gemma 4 is already installed on this device. Enable it to start the local runtime and keep ClawBox working offline."
              : "Enable Gemma 4 to install a local model that keeps ClawBox working even when cloud providers are unavailable."}
        </p>
      </div>

      <button
        type="button"
        onClick={() => saveLlamaCppConfig(selectedLlamaCppModel)}
        disabled={!!llamaCppSaving}
        className={buttonClassName}
      >
        {llamaCppSaving && buttonSpinner}
        {llamaCppSaving ? "Enabling Gemma 4..." : llamaCppRunning ? "Enable Gemma 4" : "Enable Gemma 4"}
      </button>

      {llamaCppSaving && llamaCppProgress && (
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {llamaCppProgress}
        </p>
      )}
    </div>
  );
}
