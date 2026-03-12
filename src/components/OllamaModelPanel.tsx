"use client";

import type { OllamaModel, OllamaSearchResult } from "@/hooks/useOllamaModels";
import type { ReactNode } from "react";

const PRESET_MODELS = [
  { id: "llama3.2:3b", label: "Llama 3.2 3B" },
  { id: "qwen2.5:3b-instruct-q4_K_M", label: "Qwen2.5 3B" },
];

interface OllamaModelPanelProps {
  ollamaRunning: boolean;
  ollamaModels: OllamaModel[];
  ollamaSaving: string | false;
  ollamaSearch: string;
  ollamaSearching: boolean;
  ollamaSearchResults: OllamaSearchResult[];
  ollamaPulling: boolean;
  ollamaPullProgress: { status: string; completed?: number; total?: number } | null;
  selectedOllamaModel: string;
  setSelectedOllamaModel: (model: string) => void;
  saveOllamaConfig: (model: string) => void;
  deleteOllamaModel: (model: string) => void;
  handleOllamaSearchChange: (value: string) => void;
  clearSearch: () => void;
  pullOllamaModel: (model: string) => void;
  formatOllamaBytes: (bytes: number) => string;
  /** Unique name for the radio group to avoid conflicts when used in multiple places */
  radioGroupName?: string;
  /** Class for the search input */
  inputClassName?: string;
  /** Class for the download button */
  buttonClassName?: string;
  /** Spinner element shown inside the download button */
  buttonSpinner?: ReactNode;
}

const DEFAULT_INPUT_CLASS =
  "w-full px-3.5 py-2 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500";
const DEFAULT_BUTTON_CLASS =
  "mt-3 px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-2";
const DEFAULT_SPINNER = (
  <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

export default function OllamaModelPanel({
  ollamaRunning,
  ollamaModels,
  ollamaSaving,
  ollamaSearch,
  ollamaSearching,
  ollamaSearchResults,
  ollamaPulling,
  ollamaPullProgress,
  selectedOllamaModel,
  setSelectedOllamaModel,
  saveOllamaConfig,
  deleteOllamaModel,
  handleOllamaSearchChange,
  clearSearch,
  pullOllamaModel,
  formatOllamaBytes,
  radioGroupName = "ollama-model",
  inputClassName = DEFAULT_INPUT_CLASS,
  buttonClassName = DEFAULT_BUTTON_CLASS,
  buttonSpinner = DEFAULT_SPINNER,
}: OllamaModelPanelProps) {
  if (!ollamaRunning) {
    return (
      <p className="text-xs text-yellow-400">
        Ollama is not running. Make sure it is installed and started on this device.
      </p>
    );
  }

  return (
    <>
      {ollamaModels.length > 0 && (
        <div>
          <p className="text-xs text-[var(--text-secondary)] mb-2">Installed models:</p>
          {ollamaModels.map((m) => (
            <div
              key={m.name}
              className="flex items-center justify-between py-1.5 px-3 bg-[var(--bg-deep)] rounded-lg mb-1"
            >
              <span className="text-sm text-gray-200">
                {m.name}{" "}
                <span className="text-xs text-[var(--text-muted)]">
                  ({formatOllamaBytes(m.size)})
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => saveOllamaConfig(m.name)}
                  disabled={!!ollamaSaving}
                  className="px-3 py-1 text-xs font-semibold text-white btn-gradient rounded cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                >
                  {ollamaSaving === m.name && (
                    <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                  {ollamaSaving === m.name ? "Saving..." : "Use"}
                </button>
                <button
                  type="button"
                  onClick={() => deleteOllamaModel(m.name)}
                  disabled={!!ollamaSaving || ollamaPulling}
                  className="p-1 text-gray-500 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-50"
                  title={`Delete ${m.name}`}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div>
        <h4 className="text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
          Download a model
        </h4>
        <div role="radiogroup" aria-label="Download a model" className="space-y-1">
          {PRESET_MODELS.map((m) => (
            <label
              key={m.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                selectedOllamaModel === m.id ? "bg-orange-500/10" : "hover:bg-[var(--bg-surface)]/30"
              }`}
            >
              <input
                type="radio"
                name={radioGroupName}
                value={m.id}
                checked={selectedOllamaModel === m.id}
                onChange={() => setSelectedOllamaModel(m.id)}
                className="sr-only"
              />
              <span
                className={`flex items-center justify-center w-4 h-4 rounded-full border-2 shrink-0 ${
                  selectedOllamaModel === m.id ? "border-[var(--coral-bright)]" : "border-gray-600"
                }`}
              >
                {selectedOllamaModel === m.id && (
                  <span className="w-2 h-2 rounded-full bg-orange-500" />
                )}
              </span>
              <span className="text-sm text-gray-200">{m.label}</span>
            </label>
          ))}
        </div>

        {/* Search for more models */}
        <div className="mt-3 pt-3 border-t border-gray-800">
          <p className="text-xs text-[var(--text-muted)] mb-1.5">
            Or search for more models (filtered for 8GB RAM)
          </p>
          <div className="relative">
            <input
              type="text"
              value={ollamaSearch}
              onChange={(e) => handleOllamaSearchChange(e.target.value)}
              placeholder="Search Ollama models..."
              spellCheck={false}
              autoComplete="off"
              className={inputClassName}
            />
            {ollamaSearching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 inline-block w-3.5 h-3.5 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
            )}
          </div>
          {ollamaSearchResults.length > 0 && (
            <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
              {ollamaSearchResults.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between py-1.5 px-3 bg-[var(--bg-deep)] rounded-lg"
                >
                  <div className="min-w-0 flex-1 mr-2">
                    <span className="text-sm text-gray-200 block truncate">{r.name}</span>
                    {r.description && (
                      <span className="text-xs text-[var(--text-muted)] block truncate">
                        {r.description}
                      </span>
                    )}
                    {r.filteredSizes.length > 0 && (
                      <span className="text-xs text-[var(--text-muted)]">
                        Sizes: {r.filteredSizes.join(", ")}
                        {r.pulls && <> · {r.pulls} pulls</>}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {r.filteredSizes.length > 0 ? (
                      r.filteredSizes.map((size) => (
                        <button
                          key={size}
                          type="button"
                          onClick={() => {
                            setSelectedOllamaModel(`${r.name}:${size}`);
                            clearSearch();
                          }}
                          className="px-2 py-1 text-xs font-semibold text-white btn-gradient rounded cursor-pointer"
                        >
                          {size}
                        </button>
                      ))
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedOllamaModel(r.name);
                          clearSearch();
                        }}
                        className="px-2 py-1 text-xs font-semibold text-white btn-gradient rounded cursor-pointer"
                      >
                        Select
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {ollamaSearch && !ollamaSearching && ollamaSearchResults.length === 0 && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              No models found matching &quot;{ollamaSearch}&quot; for 8GB devices
            </p>
          )}
        </div>

        {/* Show selected custom model if not in preset list */}
        {!PRESET_MODELS.some((m) => m.id === selectedOllamaModel) && (
          <div className="mt-2 px-3 py-2 bg-orange-500/10 rounded-lg">
            <span className="text-sm text-gray-200">
              Selected: <strong>{selectedOllamaModel}</strong>
            </span>
          </div>
        )}

        {ollamaPulling && ollamaPullProgress && (
          <div className="mt-2">
            <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
              <span>{ollamaPullProgress.status}</span>
              {ollamaPullProgress.total ? (
                <span>
                  {Math.round(
                    ((ollamaPullProgress.completed || 0) / ollamaPullProgress.total) * 100
                  )}
                  %
                </span>
              ) : null}
            </div>
            {ollamaPullProgress.total && (
              <div className="w-full h-2 bg-[var(--bg-deep)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all"
                  style={{
                    width: `${Math.round(
                      ((ollamaPullProgress.completed || 0) / ollamaPullProgress.total) * 100
                    )}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => pullOllamaModel(selectedOllamaModel)}
          disabled={ollamaPulling || !!ollamaSaving}
          className={buttonClassName}
        >
          {(ollamaPulling || !!ollamaSaving) && buttonSpinner}
          {ollamaPulling ? "Downloading..." : ollamaSaving ? "Configuring..." : "Download & Configure"}
        </button>
      </div>
    </>
  );
}
