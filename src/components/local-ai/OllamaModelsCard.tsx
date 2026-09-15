"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { progressPercent } from "@/lib/install-stream";
import { OLLAMA_PRESET_MODELS } from "@/lib/local-install";
import { notifyProvidersChanged } from "@/lib/ui-events";
import { useOllamaModels, type OllamaCallbacks } from "@/hooks/useOllamaModels";
import { BUTTON, CARD, CardHeading, INPUT, PRIMARY_BUTTON } from "@/components/local-ai/ui";

/**
 * Settings → Local AI → Ollama models.
 *
 * The browse-and-pull surface that only ever existed inside the setup wizard.
 * The owner's decision of 2026-09-14 makes Settings → Local AI the place local
 * models are installed from, and an extra chat model on this box is one of
 * them — so the same work is reachable after setup, not only during it.
 *
 * The LOGIC is the wizard's, unchanged: `useOllamaModels` owns the status
 * poll, the pull stream and its cancel, the delete and the configure call. It
 * is the hook and not `OllamaModelPanel` that is shared, because that component
 * wears the wizard's dress — a radio group and gradient buttons — and this page
 * is a list of compact rows. Two dresses over one hook is the right split; two
 * hooks would be two behaviours.
 *
 * `scope: "local"` when a model is chosen: this card says "use for local chat",
 * and the owner's primary provider — whatever cloud account the box is signed
 * in to — is not something a click in the on-device inventory should replace.
 */
export default function OllamaModelsCard({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useT();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const callbacks = useMemo<OllamaCallbacks>(() => ({
    onSaveSuccess: (model: string) => {
      setNote(t("localModels.ollama.nowLocal", { model }));
      notifyProvidersChanged();
      onChanged?.();
    },
    onSaveError: (message: string) => setError(message),
    onPullError: (message: string) => setError(message),
    onDeleteError: (message: string) => setError(message),
    onClearStatus: () => { setError(null); setNote(null); },
  }), [onChanged, t]);

  const ollama = useOllamaModels(callbacks, "local");
  const { checkOllamaStatus } = ollama;

  useEffect(() => { void checkOllamaStatus(); }, [checkOllamaStatus]);

  const remove = useCallback(async (model: string) => {
    setError(null);
    setNote(null);
    await ollama.deleteOllamaModel(model);
    onChanged?.();
  }, [ollama, onChanged]);

  const pull = useCallback(async (model: string) => {
    const wanted = model.trim();
    if (!wanted) return;
    await ollama.pullOllamaModel(wanted);
    onChanged?.();
  }, [ollama, onChanged]);

  const percent = progressPercent(ollama.ollamaPullProgress);
  const busy = ollama.ollamaPulling || !!ollama.ollamaSaving;

  if (!ollama.ollamaRunning) {
    return (
      <div className={CARD} data-testid="local-ai-ollama-card">
        <CardHeading title={t("localModels.ollama.title")} hint={t("localModels.ollama.hint")} />
        <p className="px-4 pb-4 text-xs text-amber-300" data-testid="local-ai-ollama-off">{t("ollama.notRunning")}</p>
      </div>
    );
  }

  return (
    <div className={CARD} data-testid="local-ai-ollama-card">
      <CardHeading title={t("localModels.ollama.title")} hint={t("localModels.ollama.hint")} />

      {ollama.ollamaModels.length > 0 ? (
        <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {ollama.ollamaModels.map((model) => (
            <li key={model.name} className="px-4 py-3 flex items-center gap-3" data-testid={`local-ai-ollama-${model.name}`}>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text-primary)] break-all">{model.name}</p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">{formatBytes(model.size, locale) ?? ""}</p>
              </div>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={busy}
                onClick={() => ollama.saveOllamaConfig(model.name)}
                data-testid={`local-ai-ollama-use-${model.name}`}
              >
                {ollama.ollamaSaving === model.name ? t("ollama.saving") : t("localModels.ollama.useForChat")}
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void remove(model.name)}
                data-testid={`local-ai-ollama-remove-${model.name}`}
              >
                {t("localModels.install.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 pb-3 text-xs text-[var(--text-secondary)]" data-testid="local-ai-ollama-empty">
          {t("localModels.ollama.none")}
        </p>
      )}

      <div className="px-4 py-3 border-t border-white/[0.06] space-y-2">
        <p className="text-xs text-[var(--text-secondary)]">
          {t("ollama.searchLabel", { max: ollama.ollamaMaxParamBillions })}
        </p>
        <div className="relative">
          <input
            type="text"
            value={ollama.ollamaSearch}
            onChange={(e) => { setError(null); ollama.handleOllamaSearchChange(e.target.value); }}
            placeholder={t("ollama.searchPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
            data-testid="local-ai-ollama-search"
          />
          {ollama.ollamaSearching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 inline-block w-3.5 h-3.5 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
          )}
        </div>

        {/* The two the wizard offers, so the commonest pick is one press here
            too rather than a name the owner has to know how to spell. */}
        {!ollama.ollamaSearch && (
          <div className="flex flex-wrap gap-2" data-testid="local-ai-ollama-presets">
            {OLLAMA_PRESET_MODELS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void pull(preset.id)}
                data-testid={`local-ai-ollama-preset-${preset.id}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}

        {ollama.ollamaSearchResults.length > 0 && (
          <ul className="max-h-48 overflow-y-auto space-y-1" data-testid="local-ai-ollama-results">
            {ollama.ollamaSearchResults.map((result) => (
              <li key={result.name} className="flex items-center gap-2 rounded-lg bg-[var(--bg-deep)] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[var(--text-primary)] truncate">{result.name}</p>
                  {result.description && (
                    <p className="text-xs text-[var(--text-secondary)] truncate">{result.description}</p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  {(result.filteredSizes.length > 0 ? result.filteredSizes : [null]).map((size) => (
                    <button
                      key={size ?? "plain"}
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      onClick={() => void pull(size ? `${result.name}:${size}` : result.name)}
                      data-testid={`local-ai-ollama-pull-${result.name}${size ? `-${size}` : ""}`}
                    >
                      {size ?? t("localModels.install.download")}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* A name the search does not know is still a name Ollama may serve. */}
        {ollama.ollamaSearch && !ollama.ollamaSearching && ollama.ollamaSearchResults.length === 0 && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !ollama.ollamaSearch.trim()}
            onClick={() => void pull(ollama.ollamaSearch)}
            data-testid="local-ai-ollama-pull-typed"
          >
            {t("ollama.useAnyway", { model: ollama.ollamaSearch.trim() })}
          </button>
        )}

        {ollama.ollamaPulling && (
          <div data-testid="local-ai-ollama-progress">
            <div className="flex items-center justify-between gap-2">
              <p role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)] break-words">
                {ollama.ollamaPullProgress?.status ?? t("ollama.downloading")}
              </p>
              <button
                type="button"
                className={BUTTON}
                onClick={ollama.cancelOllamaPull}
                data-testid="local-ai-ollama-cancel"
              >
                {t("cancel")}
              </button>
            </div>
            {percent !== null && (
              <div
                className="mt-1 h-1.5 w-full rounded-full bg-white/[0.08] overflow-hidden"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                data-testid="local-ai-ollama-progress-bar"
              >
                <div className="h-full rounded-full bg-[var(--coral-bright)] transition-all" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-300 break-words" data-testid="local-ai-ollama-error">{error}</p>
        )}
        {note && (
          <p role="status" className="text-xs text-cyan-300 break-words" data-testid="local-ai-ollama-note">{note}</p>
        )}
      </div>
    </div>
  );
}
