"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";
import { CARD, CardHeading, InstallOutcomeView, InstallProgressView, PRIMARY_BUTTON } from "@/components/local-ai/ui";
import { useStreamedInstall } from "@/components/local-ai/use-streamed-install";

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

/** The route's answer, or null for anything that is not one. */
async function readStatus(): Promise<EmbedStatus | null> {
  try {
    const res = await fetch("/setup-api/embed/status", { cache: "no-store" });
    const data = res.ok ? await res.json() : null;
    return isStatus(data) ? data : null;
  } catch {
    return null;
  }
}

export default function EmbeddingModelCard({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useT();
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const install = useStreamedInstall();

  useEffect(() => {
    let alive = true;
    void readStatus().then((next) => { if (alive && next) setStatus(next); });
    return () => { alive = false; };
  }, []);

  const download = async (force: boolean) => {
    const ok = await install.run("embed", (signal) => fetch("/setup-api/embed/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
      signal,
    }));
    // Keep the last good reading rather than blanking the card.
    const next = await readStatus();
    if (next) setStatus(next);
    if (ok) onChanged?.();
  };

  if (!status) return null;
  const size = formatBytes(status.modelBytes, locale);
  const busy = install.busy !== null;

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
      <div className="px-4 pb-4 -mt-2">
        <InstallProgressView progress={install.progress} testId="local-ai-embed-progress" />
        <InstallOutcomeView outcome={install.outcome} testId="local-ai-embed-outcome" />
      </div>
    </div>
  );
}
