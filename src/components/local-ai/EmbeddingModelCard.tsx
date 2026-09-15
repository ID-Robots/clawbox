"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";
import { BUTTON, CARD, CardHeading, InstallOutcomeView, InstallProgressView, PRIMARY_BUTTON } from "@/components/local-ai/ui";
import { describeRefusal, useStreamedInstall } from "@/components/local-ai/use-streamed-install";

/**
 * Settings → Local AI → the memory-search model.
 *
 * The one model here that still arrives on its own: `ensure-local-embeddings.sh`
 * fetches the Qwen3 GGUF in the background on every gateway start, because the
 * memory index is unusable without it and OpenClaw gives a document batch 120 s.
 * That stays. What this card adds is the state nobody could see — is the GGUF
 * actually here, how big is it — and the two buttons that were a terminal job:
 * download it again (a box whose copy is truncated has no other repair), and
 * take it off.
 *
 * Remove stops the unit first: llama-server holds the weights open and
 * unlinking underneath it frees nothing until it exits.
 */

interface EmbedStatus {
  installed: boolean;
  binaryAvailable: boolean;
  modelAvailable: boolean;
  modelBytes: number | null;
  model: string;
  engine: string;
}

function isStatus(value: unknown): value is EmbedStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.installed === "boolean"
    && typeof v.modelAvailable === "boolean"
    && typeof v.model === "string";
}

export default function EmbeddingModelCard({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const install = useStreamedInstall();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/embed/status", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (isStatus(data)) setStatus(data);
    } catch {
      /* keep the last good reading */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const download = async (force: boolean) => {
    setNote(null);
    const ok = await install.run("embed", (signal) => fetch("/setup-api/embed/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
      signal,
    }));
    await refresh();
    if (ok) onChanged?.();
  };

  const remove = async () => {
    setRemoving(true);
    setNote(null);
    install.reset();
    try {
      const res = await fetch("/setup-api/embed/install", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(describeRefusal(t, locale, data as Record<string, unknown>));
        return;
      }
      const freed = typeof data?.freedBytes === "number" ? formatBytes(data.freedBytes, locale) : null;
      if (freed) setNote(t("localModels.install.freed", { size: freed }));
      await refresh();
      onChanged?.();
    } catch {
      setNote(t("localModels.error.unreachable"));
    } finally {
      setRemoving(false);
    }
  };

  if (!status) return null;
  const size = formatBytes(status.modelBytes, locale);
  const busy = install.busy !== null || removing;

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
        {status.modelAvailable && (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void remove()}
            data-testid="local-ai-embed-remove"
          >
            {removing ? t("localModels.install.removing") : t("localModels.install.remove")}
          </button>
        )}
      </div>
      <div className="px-4 pb-4 -mt-2">
        <InstallProgressView progress={install.progress} testId="local-ai-embed-progress" />
        <InstallOutcomeView outcome={install.outcome} testId="local-ai-embed-outcome" />
        {note && (
          <p role="status" className="text-xs text-[var(--text-secondary)] mt-1" data-testid="local-ai-embed-note">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
