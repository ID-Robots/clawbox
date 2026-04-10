"use client";

import { useCallback, useState } from "react";

export interface LlamaCppModel {
  id: string;
  owned_by?: string;
}

export interface LlamaCppCallbacks {
  onSaveSuccess: (model: string) => void;
  onSaveError: (message: string) => void;
  onClearStatus?: () => void;
}

type ConfigureScope = "primary" | "local";

export function useLlamaCppModels(callbacks: LlamaCppCallbacks, configureScope: ConfigureScope = "primary") {
  const { onSaveSuccess, onSaveError, onClearStatus } = callbacks;
  const [llamaCppRunning, setLlamaCppRunning] = useState(false);
  const [llamaCppModels, setLlamaCppModels] = useState<LlamaCppModel[]>([]);
  const [llamaCppEndpoint, setLlamaCppEndpoint] = useState("");
  const [llamaCppSaving, setLlamaCppSaving] = useState<string | false>(false);
  const [llamaCppProgress, setLlamaCppProgress] = useState<string | null>(null);

  const checkLlamaCppStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/llamacpp/status");
      if (!res.ok) {
        setLlamaCppRunning(false);
        setLlamaCppModels([]);
        return;
      }

      const data = await res.json();
      setLlamaCppRunning(!!data.running);
      setLlamaCppModels(Array.isArray(data.models) ? data.models : []);
      setLlamaCppEndpoint(typeof data.baseUrl === "string" ? data.baseUrl : "");
    } catch {
      setLlamaCppRunning(false);
      setLlamaCppModels([]);
    }
  }, []);

  const saveLlamaCppConfig = useCallback(async (model: string) => {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      onSaveError("Enter the llama.cpp model ID first.");
      return;
    }

    setLlamaCppSaving(trimmedModel);
    setLlamaCppProgress("Preparing llama.cpp...");
    onClearStatus?.();

    try {
      const res = await fetch("/setup-api/llamacpp/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: trimmedModel,
          scope: configureScope,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onSaveError(data.error || "Failed to install llama.cpp");
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        onSaveError("No install progress received from llama.cpp");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let installedModel = trimmedModel;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line) {
            try {
              const payload = JSON.parse(line) as {
                status?: string;
                error?: string;
                success?: boolean;
                model?: string;
              };
              if (payload.status) setLlamaCppProgress(payload.status);
              if (payload.model) installedModel = payload.model;
              if (payload.error) {
                onSaveError(payload.error);
                return;
              }
              if (payload.success) {
                await checkLlamaCppStatus();
                onSaveSuccess(installedModel);
                return;
              }
            } catch {
              // Ignore malformed partial progress lines.
            }
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }

      onSaveError("llama.cpp install ended before the server became ready.");
    } catch (err) {
      onSaveError(
        `Failed: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      setLlamaCppSaving(false);
      setLlamaCppProgress(null);
    }
  }, [checkLlamaCppStatus, configureScope, onClearStatus, onSaveError, onSaveSuccess]);

  return {
    llamaCppRunning,
    llamaCppModels,
    llamaCppEndpoint,
    llamaCppSaving,
    llamaCppProgress,
    checkLlamaCppStatus,
    saveLlamaCppConfig,
  };
}
