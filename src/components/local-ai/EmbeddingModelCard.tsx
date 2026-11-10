"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";
import { findRunningBackgroundTask } from "@/lib/background-task-client";
import { EMBED_MODEL_DOWNLOAD_KIND } from "@/lib/background-task-kinds";
import { BackgroundTaskInline } from "@/components/BackgroundTaskProgress";
import { BUTTON, CARD, CardHeading, InstallOutcomeView, InstallProgressView, PRIMARY_BUTTON } from "@/components/local-ai/ui";
import { useStreamedInstall } from "@/components/local-ai/use-streamed-install";
import { parseLocalEmbeddingModelOptions, type LocalEmbeddingModelOption } from "@/lib/local-embedding-gating";
import { switchLocalEmbeddingModel, unavailableReasonKey } from "@/lib/local-embedding-client";
import { notifyMemoryShardChanged } from "@/lib/ui-events";

/**
 * Settings → Local AI → the memory-search model.
 *
 * The one model here that still arrives on its own: `ensure-local-embeddings.sh`
 * fetches the Qwen3 GGUF in the background on every gateway start, because the
 * memory index is unusable without it and OpenClaw gives a document batch 120 s.
 * That stays. What this card adds is the state nobody could see — is the GGUF
 * actually here, how big is it — and the one button that was a terminal job:
 * download it again (a box whose copy is truncated has no other repair).
 * Taking it off is the row's own Uninstall, and the panel draws this card only
 * under a row that is installed and not switched off.
 *
 * And WHICH model (TASK-2411): one row per model on offer — Qwen3-Embedding-
 * 0.6B everywhere, the 4B where this box can run it, and the plain reason
 * where it cannot (a Jetson, a PC without an NVIDIA GPU). A row downloads its
 * model, switches memory search onto it (which re-embeds every file), or
 * removes a copy that is not in use: a switch never deletes the other file.
 */

interface EmbedStatus {
  installed: boolean;
  binaryAvailable: boolean;
  modelAvailable: boolean;
  modelBytes: number | null;
  model: string;
  engine: string;
  /** Every model on offer, from a server that has the choice (TASK-2411). */
  models: LocalEmbeddingModelOption[];
}

function isStatus(value: unknown): value is EmbedStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.installed === "boolean"
    && typeof v.modelAvailable === "boolean"
    && typeof v.model === "string";
}

/** The route's answer, or null for anything that is not one. */
async function readStatus(): Promise<EmbedStatus | null> {
  try {
    const res = await fetch("/setup-api/embed/status", { cache: "no-store" });
    const data = res.ok ? await res.json() : null;
    return isStatus(data) ? { ...data, models: parseLocalEmbeddingModelOptions((data as { models?: unknown }).models) } : null;
  } catch {
    return null;
  }
}

export default function EmbeddingModelCard({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const install = useStreamedInstall();
  const { follow } = install;

  useEffect(() => {
    let alive = true;
    void readStatus().then((next) => { if (alive && next) setStatus(next); });
    return () => { alive = false; };
  }, []);

  const settle = useCallback(async (ok: boolean) => {
    // Keep the last good reading rather than blanking the card.
    const next = await readStatus();
    if (next) setStatus(next);
    if (ok) onChanged?.();
  }, [onChanged]);

  // RE-ATTACH. The download is a background task of the box: a Settings
  // reopened while it runs follows it again here, with the same progress and
  // verdict as the click that started it. Once per mount.
  const attachedRef = useRef(false);
  useEffect(() => {
    if (attachedRef.current) return;
    let alive = true;
    void findRunningBackgroundTask([EMBED_MODEL_DOWNLOAD_KIND]).then(async (task) => {
      if (!alive || !task || attachedRef.current) return;
      attachedRef.current = true;
      await settle(await follow("embed", task.id));
    });
    return () => { alive = false; };
  }, [follow, settle]);

  const download = async (force: boolean) => {
    const ok = await install.run("embed", (signal) => fetch("/setup-api/embed/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
      signal,
    }));
    await settle(ok);
  };

  const [rowBusy, setRowBusy] = useState<string | null>(null);
  // Where the index is embedded. "Use" points memory search at a model ON THIS
  // BOX, so over an index in the cloud it would quietly move it off the cloud
  // too; that move is Memory Shard's switch, which says what it costs.
  const [indexSource, setIndexSource] = useState<"cloud" | "local" | null>(null);
  // A read that failed (an unreadable config answers 503) is asked again
  // every few seconds, with a line saying why "Use" waits meanwhile.
  const [sourceFailed, setSourceFailed] = useState(false);
  const [sourceTick, setSourceTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    void fetch("/setup-api/clawkeep/memory/provider", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body: { source?: unknown } | null) => {
        if (!alive) return;
        if (body?.source === "cloud" || body?.source === "local") {
          setIndexSource(body.source);
          setSourceFailed(false);
        } else {
          setSourceFailed(true);
          retry = setTimeout(() => setSourceTick((n) => n + 1), 5_000);
        }
      });
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [status?.model, sourceTick]);
  const [rowError, setRowError] = useState<string | null>(null);

  const fetchModel = async (model: LocalEmbeddingModelOption) => {
    setRowError(null);
    const ok = await install.run("embed", (signal) => fetch("/setup-api/embed/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.id }),
      signal,
    }));
    await settle(ok);
  };

  const pickModel = async (model: LocalEmbeddingModelOption) => {
    setRowError(null);
    setRowBusy(model.id);
    try {
      await switchLocalEmbeddingModel(model.id, t("clawkeep.memory.embedder.failed"));
      notifyMemoryShardChanged();
    } catch (err) {
      setRowError(err instanceof Error && err.message ? err.message : t("clawkeep.memory.embedder.failed"));
    } finally {
      setRowBusy(null);
      await settle(true);
    }
  };

  const removeModel = async (model: LocalEmbeddingModelOption) => {
    setRowError(null);
    setRowBusy(model.id);
    try {
      const res = await fetch(`/setup-api/embed/install?model=${encodeURIComponent(model.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setRowError(typeof body?.error === "string" ? body.error : t("clawkeep.memory.embedder.failed"));
      }
    } finally {
      setRowBusy(null);
      await settle(true);
    }
  };

  if (!status) return null;
  const size = formatBytes(status.modelBytes, locale);
  const busy = install.busy !== null || rowBusy !== null;

  return (
    <div className={CARD} data-testid="local-ai-embed-card">
      <CardHeading title={t("localModels.embed.title")} hint={t("localModels.embed.hint")} />
      <div className="px-4 pb-4 flex items-center gap-3">
        <p className="flex-1 min-w-0 text-xs text-[var(--text-secondary)]" data-testid="local-ai-embed-state">
          {status.modelAvailable
            ? t("localModels.embed.present", { model: status.model, size: size ?? "" })
            : t("localModels.embed.missing", { model: status.model })}
        </p>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={busy}
          onClick={() => void download(status.modelAvailable)}
          data-testid="local-ai-embed-download"
        >
          {install.busy
            ? t("localModels.install.downloading")
            : status.modelAvailable ? t("localModels.embed.again") : t("localModels.install.download")}
        </button>
      </div>
      {status.models.length > 1 && (
        <ul className="px-4 pb-4 -mt-1 flex flex-col gap-2" data-testid="local-ai-embed-models">
          {status.models.map((model) => (
            <li
              key={model.id}
              className="rounded-xl border border-[var(--border-subtle)] px-3 py-2"
              data-testid={`local-ai-embed-model-${model.id}`}
            >
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--text-primary)] truncate">
                    {model.label}
                    <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">{model.dimensions}d</span>
                  </p>
                  <p className="text-[11px] text-[var(--text-muted)]" data-testid={`local-ai-embed-model-${model.id}-state`}>
                    {model.active
                      ? t("localModels.embed.inUse")
                      : model.installed
                        ? t("localModels.embed.downloaded", { size: formatBytes(model.bytes, locale) ?? "" })
                        : t("localModels.embed.notDownloaded")}
                  </p>
                </div>
                {model.available && !model.active && !model.installed && (
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => void fetchModel(model)}
                    data-testid={`local-ai-embed-model-${model.id}-download`}>
                    {t("localModels.install.download")}
                    {model.bytes ? ` · ${formatBytes(model.bytes, locale)}` : ""}
                  </button>
                )}
                {model.available && !model.active && model.installed && (
                  <button type="button" className={PRIMARY_BUTTON} disabled={busy || indexSource !== "local"} onClick={() => void pickModel(model)}
                    data-testid={`local-ai-embed-model-${model.id}-use`}>
                    {t("localModels.embed.use")}
                  </button>
                )}
                {!model.active && model.installed && (
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => void removeModel(model)}
                    data-testid={`local-ai-embed-model-${model.id}-remove`}>
                    {t("localModels.embed.remove")}
                  </button>
                )}
              </div>
              {!model.available && (
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid={`local-ai-embed-model-${model.id}-unavailable`}>
                  {t(unavailableReasonKey(model.reason))}
                </p>
              )}
            </li>
          ))}
          <li className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t("localModels.embed.switchHint")}</li>
          {indexSource === "cloud" && (
            <li className="text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="local-ai-embed-models-cloud">
              {t("localModels.embed.cloudInUse")}
            </li>
          )}
          {indexSource === null && sourceFailed && status.models.some((m) => m.available && m.installed && !m.active) && (
            <li className="text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="local-ai-embed-models-source-unknown">
              {t("localModels.embed.sourceUnknown")}
            </li>
          )}
          {rowError && (
            <li className="text-[11px] text-red-400" role="alert" data-testid="local-ai-embed-models-error">{rowError}</li>
          )}
        </ul>
      )}
      <div className="px-4 pb-4 -mt-2">
        {install.taskId
          ? <BackgroundTaskInline taskId={install.taskId} testId="local-ai-embed-task" />
          : <InstallProgressView progress={install.progress} testId="local-ai-embed-progress" />}
        <InstallOutcomeView outcome={install.outcome} testId="local-ai-embed-outcome" />
      </div>
    </div>
  );
}
