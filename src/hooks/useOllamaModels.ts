"use client";

import { useState, useRef, useCallback, useEffect } from "react";

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
  /** Called before save/pull actions to clear previous status messages */
  onClearStatus?: () => void;
}

export function useOllamaModels(callbacks: OllamaCallbacks) {
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

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    [callbacks]
  );

  const pullOllamaModel = useCallback(
    async (model: string) => {
      setOllamaPulling(true);
      setOllamaPullProgress(null);
      callbacks.onClearStatus?.();
      try {
        const res = await fetch("/setup-api/ollama/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        if (!res.ok || !res.body) {
          callbacks.onPullError("Failed to start model download");
          setOllamaPulling(false);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const prog = JSON.parse(line);
              setOllamaPullProgress(prog);
            } catch {
              /* skip */
            }
          }
        }
        await checkOllamaStatus();
        setOllamaPulling(false);
        await saveOllamaConfig(model);
      } catch (err) {
        callbacks.onPullError(
          `Download failed: ${err instanceof Error ? err.message : err}`
        );
        setOllamaPulling(false);
      }
    },
    [callbacks, checkOllamaStatus, saveOllamaConfig]
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
    checkOllamaStatus,
    searchOllamaModels,
    handleOllamaSearchChange,
    pullOllamaModel,
    saveOllamaConfig,
    selectExistingOllamaModel,
    formatOllamaBytes,
    clearSearch,
  };
}
