"use client";

import { useEffect } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { LLAMACPP_RECOMMENDED_MODELS, getDefaultLlamaCppModel } from "@/lib/llamacpp";
import type { LlamaCppModel } from "@/hooks/useLlamaCppModels";

interface LlamaCppModelPanelProps {
  llamaCppRunning: boolean;
  llamaCppModels: LlamaCppModel[];
  llamaCppEndpoint: string;
  llamaCppSaving: string | false;
  llamaCppProgress?: string | null;
  selectedLlamaCppModel: string;
  setSelectedLlamaCppModel: (model: string) => void;
  saveLlamaCppConfig: (model: string) => void;
  inputClassName?: string;
  buttonClassName?: string;
  buttonSpinner?: ReactNode;
}

const DEFAULT_INPUT_CLASS =
  "w-full px-3.5 py-2 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500";
const DEFAULT_BUTTON_CLASS =
  "mt-3 px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-2";
const DEFAULT_SPINNER = (
  <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

export default function LlamaCppModelPanel({
  llamaCppRunning,
  llamaCppModels,
  llamaCppEndpoint,
  llamaCppSaving,
  llamaCppProgress,
  selectedLlamaCppModel,
  setSelectedLlamaCppModel,
  saveLlamaCppConfig,
  inputClassName = DEFAULT_INPUT_CLASS,
  buttonClassName = DEFAULT_BUTTON_CLASS,
  buttonSpinner = DEFAULT_SPINNER,
}: LlamaCppModelPanelProps) {
  useEffect(() => {
    if (selectedLlamaCppModel) return;
    if (llamaCppModels.length > 0) {
      setSelectedLlamaCppModel(llamaCppModels[0].id);
    } else {
      setSelectedLlamaCppModel(getDefaultLlamaCppModel());
    }
  }, [llamaCppModels, selectedLlamaCppModel, setSelectedLlamaCppModel]);

  const handleRecommendedModelKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();

    const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = (index + delta + LLAMACPP_RECOMMENDED_MODELS.length) % LLAMACPP_RECOMMENDED_MODELS.length;
    const nextModel = LLAMACPP_RECOMMENDED_MODELS[nextIndex];
    if (!nextModel) return;

    setSelectedLlamaCppModel(nextModel.id);
    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[nextIndex]?.focus();
  };

  return (
    <div className="space-y-3">
      <p className={`text-xs ${llamaCppRunning ? "text-[var(--text-secondary)]" : "text-yellow-400"}`}>
        {llamaCppRunning
          ? `Connected to llama.cpp at ${llamaCppEndpoint || "the configured endpoint"}.`
          : `llama.cpp is not responding at ${llamaCppEndpoint || "the configured endpoint"}. ClawBox can download the recommended Gemma model and start llama-server for you, or you can point this at an existing endpoint.`}
      </p>

      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-3">
        <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">
          Recommended for 8GB devices
        </p>
        <div role="radiogroup" aria-label="Recommended llama.cpp models" className="space-y-2">
          {LLAMACPP_RECOMMENDED_MODELS.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => setSelectedLlamaCppModel(model.id)}
              onKeyDown={(event) => handleRecommendedModelKeyDown(event, LLAMACPP_RECOMMENDED_MODELS.findIndex((m) => m.id === model.id))}
              role="radio"
              aria-checked={selectedLlamaCppModel === model.id}
              aria-label={model.label}
              tabIndex={selectedLlamaCppModel === model.id ? 0 : -1}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${
                selectedLlamaCppModel === model.id
                  ? "border-[var(--coral-bright)] bg-orange-500/10"
                  : "border-[var(--border-subtle)] hover:bg-[var(--bg-surface)]/40"
              }`}
            >
              <span className="block text-sm font-semibold text-gray-100">{model.label}</span>
              <span className="block text-xs text-[var(--text-secondary)] mt-1">{model.description}</span>
              <span className="block text-xs text-[var(--text-muted)] mt-1">{model.memoryNote}</span>
              <span className="block text-[11px] text-[var(--text-muted)] mt-1.5 font-mono">
                Suggested model id: {model.id}
              </span>
            </button>
          ))}
        </div>
      </div>

      {llamaCppModels.length > 0 && (
        <div>
          <p className="text-xs text-[var(--text-secondary)] mb-2">Detected models</p>
          <div className="space-y-1.5">
            {llamaCppModels.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between py-2 px-3 bg-[var(--bg-deep)] rounded-lg"
              >
                <div className="min-w-0 mr-3">
                  <span className="text-sm text-gray-200 block truncate">{model.id}</span>
                  {model.owned_by && (
                    <span className="text-xs text-[var(--text-muted)] block truncate">
                      {model.owned_by}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => saveLlamaCppConfig(model.id)}
                  disabled={!!llamaCppSaving}
                  aria-label={`Use ${model.id}`}
                  className="px-3 py-1 text-xs font-semibold text-white btn-gradient rounded cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                >
                  {llamaCppSaving === model.id && (
                    <span aria-hidden="true" className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                  {llamaCppSaving === model.id && <span className="sr-only">{`Saving ${model.id}`}</span>}
                  {llamaCppSaving === model.id ? "Saving..." : "Use"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <label
          htmlFor="llamacpp-model-id"
          className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5"
        >
          Model ID
        </label>
        <input
          id="llamacpp-model-id"
          type="text"
          value={selectedLlamaCppModel}
          onChange={(e) => setSelectedLlamaCppModel(e.target.value)}
          placeholder={getDefaultLlamaCppModel()}
          spellCheck={false}
          autoComplete="off"
          className={inputClassName}
        />
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          Match the model id exposed by <code>llama-server</code> at <code>/v1/models</code>. If you launch your own Gemma 4 E2B Q4/INT4 quant, reusing the suggested alias above makes setup easier.
        </p>
      </div>

      <button
        type="button"
        onClick={() => saveLlamaCppConfig(selectedLlamaCppModel)}
        disabled={!!llamaCppSaving || !selectedLlamaCppModel.trim()}
        className={buttonClassName}
      >
        {llamaCppSaving && buttonSpinner}
        {llamaCppSaving ? "Installing..." : llamaCppRunning ? "Use llama.cpp" : "Install & Use llama.cpp"}
      </button>

      {llamaCppSaving && llamaCppProgress && (
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {llamaCppProgress}
        </p>
      )}
    </div>
  );
}
