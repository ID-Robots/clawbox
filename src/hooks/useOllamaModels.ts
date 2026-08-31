"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { OLLAMA_MAX_MODEL_PARAM_B } from "@/lib/resource-limits";

export interface OllamaModel {
  name: string;
  size: number;
}

export interface OllamaSearchResult {
  name: string;
  description: string;
  pulls: string;
  filteredSizes: string[];
}

export interface OllamaCallbacks {
  onSaveSuccess: (model: string) => void;
  onSaveError: (message: string) => void;
  onPullError: (message: string) => void;
  onDeleteError: (message: string) => void;
  /** Called before save/pull actions to clear previous status messages */
  onClearStatus?: () => void;
}

type ConfigureScope = "primary" | "local";

export function useOllamaModels(callbacks: OllamaCallbacks, configureScope: ConfigureScope = "primary") {
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaSearch, setOllamaSearch] = useState("");
  const [ollamaSearchResults, setOllamaSearchResults] = useState<OllamaSearchResult[]>([]);
  const [ollamaSearching, setOllamaSearching] = useState(false);
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaPullProgress, setOllamaPullProgress] = useState<{
    status: string;
    completed?: number;
    total?: number;
  } | null>(null);
  const [ollamaSaving, setOllamaSaving] = useState<string | false>(false);
  // The size cap the search route filters by, so the panel's copy names the
  // figure the results were actually cut at; the constant until the first
  // answer arrives (the route derives it from the same limit).
  const [ollamaMaxParamBillions, setOllamaMaxParamBillions] = useState<number>(OLLAMA_MAX_MODEL_PARAM_B);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullAbortRef = useRef<AbortController | null>(null);

  // Cleanup search timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const checkOllamaStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/ollama/status");
      if (!res.ok) {
        setOllamaRunning(false);
        setOllamaModels([]);
        return;
      }
      const data = await res.json();
      setOllamaRunning(data.running);
      setOllamaModels(data.models || []);
    } catch {
      setOllamaRunning(false);
      setOllamaModels([]);
    }
  }, []);

  const searchOllamaModels = useCallback(async (query: string) => {
    if (!query.trim()) {
      setOllamaSearchResults([]);
      return;
    }
    setOllamaSearching(true);
    try {
      const res = await fetch(
        `/setup-api/ollama/search?q=${encodeURIComponent(query)}`
      );
      if (!res.ok) {
        setOllamaSearchResults([]);
        return;
      }
      const data = await res.json();
      setOllamaSearchResults(data.results || []);
      if (typeof data.maxParamBillions === "number" && data.maxParamBillions > 0) {
        setOllamaMaxParamBillions(data.maxParamBillions);
      }
    } catch {
      setOllamaSearchResults([]);
    } finally {
      setOllamaSearching(false);
    }
  }, []);

  const handleOllamaSearchChange = useCallback(
    (value: string) => {
      setOllamaSearch(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(
        () => searchOllamaModels(value),
        400
      );
    },
    [searchOllamaModels]
  );

  const formatOllamaBytes = useCallback((bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${bytes} B`;
  }, []);

  const saveOllamaConfig = useCallback(
    async (model: string) => {
      setOllamaSaving(model);
      callbacks.onClearStatus?.();
      try {
        const res = await fetch("/setup-api/ai-models/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "ollama",
            apiKey: model,
            authMode: "local",
            scope: configureScope,
          }),
        });
        const data = await res.json();
        if (data.success) {
          callbacks.onSaveSuccess(model);
        } else {
          callbacks.onSaveError(data.error || "Failed to configure");
        }
      } catch (err) {
        callbacks.onSaveError(
          `Failed: ${err instanceof Error ? err.message : err}`
        );
      } finally {
        setOllamaSaving(false);
      }
    },
    [callbacks, configureScope]
  );

  const pullOllamaModel = useCallback(
    async (model: string) => {
      setOllamaPulling(true);
      setOllamaPullProgress(null);
      callbacks.onClearStatus?.();
      const abort = new AbortController();
      pullAbortRef.current = abort;
      try {
        const res = await fetch("/setup-api/ollama/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          callbacks.onPullError("Failed to start model download");
          setOllamaPulling(false);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // The route forwards Ollama's failure as a 200 stream line `{error}`;
        // it ends the pull, and the model is not there to configure.
        let pullError: string | null = null;
        let finished = false;
        while (!pullError) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const prog = JSON.parse(line);
              if (typeof prog.error === "string") {
                pullError = prog.error;
                break;
              }
              if (prog.status === "success") finished = true;
              setOllamaPullProgress(prog);
            } catch {
              /* skip */
            }
          }
        }
        if (pullError) await reader.cancel().catch(() => {});
        await checkOllamaStatus();
        setOllamaPulling(false);
        setOllamaPullProgress(null);
        if (pullError) {
          callbacks.onPullError(pullError);
          return;
        }
        // Only a stream that reached Ollama's terminal line has the model on
        // disk; one cut mid-download must not end in "Pull the model first".
        if (!finished) {
          callbacks.onPullError("Download did not finish");
          return;
        }
        await saveOllamaConfig(model);
      } catch (err) {
        setOllamaPulling(false);
        setOllamaPullProgress(null);
        // Cancelled by the owner: the route drops the Ollama connection with
        // the request, so nothing keeps downloading. Not a failure to report.
        if (abort.signal.aborted) {
          await checkOllamaStatus();
          return;
        }
        callbacks.onPullError(
          `Download failed: ${err instanceof Error ? err.message : err}`
        );
      } finally {
        if (pullAbortRef.current === abort) pullAbortRef.current = null;
      }
    },
    [callbacks, checkOllamaStatus, saveOllamaConfig]
  );

  /** Stop the pull in flight, if any. Ollama keeps the partial blobs, so a retry resumes. */
  const cancelOllamaPull = useCallback(() => {
    pullAbortRef.current?.abort();
  }, []);

  const deleteOllamaModel = useCallback(
    async (model: string) => {
      try {
        const res = await fetch("/setup-api/ollama/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          callbacks.onDeleteError(
            typeof data.error === "string" ? data.error : "Failed to delete model"
          );
        }
      } catch (err) {
        callbacks.onDeleteError(
          `Failed to delete model: ${err instanceof Error ? err.message : err}`
        );
      } finally {
        // Always reconcile against the daemon: a partial/failed delete still
        // needs the list refreshed so the UI reflects reality.
        await checkOllamaStatus();
      }
    },
    [callbacks, checkOllamaStatus]
  );

  const selectExistingOllamaModel = useCallback(
    async (model: string) => {
      await saveOllamaConfig(model);
    },
    [saveOllamaConfig]
  );

  const clearSearch = useCallback(() => {
    setOllamaSearch("");
    setOllamaSearchResults([]);
  }, []);

  return {
    ollamaRunning,
    ollamaModels,
    ollamaSearch,
    ollamaSearchResults,
    ollamaSearching,
    ollamaPulling,
    ollamaPullProgress,
    ollamaSaving,
    ollamaMaxParamBillions,
    checkOllamaStatus,
    searchOllamaModels,
    handleOllamaSearchChange,
    pullOllamaModel,
    cancelOllamaPull,
    saveOllamaConfig,
    selectExistingOllamaModel,
    deleteOllamaModel,
    formatOllamaBytes,
    clearSearch,
  };
}
