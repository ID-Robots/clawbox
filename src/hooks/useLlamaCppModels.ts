"use client";

import { useCallback, useState } from "react";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";

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
  const [llamaCppInstalled, setLlamaCppInstalled] = useState(false);
  const [llamaCppModels, setLlamaCppModels] = useState<LlamaCppModel[]>([]);
  const [llamaCppEndpoint, setLlamaCppEndpoint] = useState("");
  const [llamaCppSaving, setLlamaCppSaving] = useState<string | false>(false);
  const [llamaCppProgress, setLlamaCppProgress] = useState<string | null>(null);

  const checkLlamaCppStatus = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/llamacpp/status");
      if (!res.ok) {
        setLlamaCppRunning(false);
        setLlamaCppInstalled(false);
        setLlamaCppModels([]);
        return;
      }

      const data = await res.json();
      setLlamaCppRunning(!!data.running);
      setLlamaCppInstalled(!!data.installed);
      setLlamaCppModels(Array.isArray(data.models) ? data.models : []);
      setLlamaCppEndpoint(typeof data.baseUrl === "string" ? data.baseUrl : "");
    } catch {
      setLlamaCppRunning(false);
      setLlamaCppInstalled(false);
      setLlamaCppModels([]);
    }
  }, []);

  /**
   * One POST to /setup-api/llamacpp/install with its NDJSON progress stream
   * read to a terminal line, reported through the shared callbacks.
   *
   * Both entry points below go through here, and the only thing that differs
   * between them is the request body. A second copy of this reader is how one
   * of them would quietly stop surfacing failures the other still surfaces:
   * this route reports an install error IN the stream body, not by status code,
   * so a caller that stops reading at the headers calls a failed install a
   * success.
   *
   * `savingKey` is only what `llamaCppSaving` exposes for per-row spinners; the
   * request is `body` alone.
   */
  const runLlamaCppInstall = useCallback(async (
    body: { model?: string; scope: ConfigureScope; activate: boolean },
    savingKey: string,
  ) => {
    setLlamaCppSaving(savingKey);
    setLlamaCppProgress(llamaCppInstalled ? "Checking local Gemma 4 runtime..." : "Preparing llama.cpp...");
    onClearStatus?.();

    try {
      const res = await fetch("/setup-api/llamacpp/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      // The server picks the alias when the body omits one, and it names the
      // choice on the success line — so this starts at whatever was asked for
      // (if anything) and `payload.model` corrects it.
      let installedModel = body.model ?? savingKey;

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
  }, [checkLlamaCppStatus, llamaCppInstalled, onClearStatus, onSaveError, onSaveSuccess]);

  // `options.activate` = the user clicked "Switch to Gemma 4", i.e. asked for
  // this model to become the one that answers. A plain enable omits it and
  // keeps the customer's chosen provider in place.
  const saveLlamaCppConfig = useCallback(async (model: string, options?: { activate?: boolean }) => {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      onSaveError("Enter the llama.cpp model ID first.");
      return;
    }

    await runLlamaCppInstall(
      { model: trimmedModel, scope: configureScope, activate: options?.activate === true },
      trimmedModel,
    );
  }, [configureScope, onSaveError, runLlamaCppInstall]);

  /**
   * "I'll use only local AI": bring Gemma 4 up, register the `llamacpp`
   * provider, and make it the model that answers.
   *
   * `scope: "local"` is deliberately NOT this hook's ambient `configureScope`,
   * and that difference is the whole point. Only the local scope reaches the
   * branch of ai-models/configure that writes `local_ai_configured` /
   * `local_ai_model` and starts the runtime, and only it feeds
   * `shouldPromoteLocalToPrimary` (src/app/setup-api/ai-models/configure/route.ts:2229).
   * The wizard's ambient scope is "primary", which does register the provider
   * but leaves the box with no `local_ai_model` — Settings → Local AI would
   * then show Gemma as unconfigured, and the Local-only switch would refuse
   * with "Local AI is not configured"
   * (src/app/setup-api/local-ai/exclusive/route.ts:404).
   *
   * This is the same request Settings → Local AI → "Make primary" already sends
   * (src/components/LocalAiPanel.tsx:445) — the path measured working on a
   * device — down to omitting `model` so the SERVER picks the alias. Sending
   * the browser's idea of the default instead would disagree with the server on
   * any box that sets LLAMACPP_MODEL, since that variable is not exposed to the
   * client bundle.
   */
  const activateLocalOnly = useCallback(async () => {
    await runLlamaCppInstall({ scope: "local", activate: true }, getDefaultLlamaCppModel());
  }, [runLlamaCppInstall]);

  return {
    llamaCppRunning,
    llamaCppInstalled,
    llamaCppModels,
    llamaCppEndpoint,
    llamaCppSaving,
    llamaCppProgress,
    checkLlamaCppStatus,
    saveLlamaCppConfig,
    activateLocalOnly,
  };
}
