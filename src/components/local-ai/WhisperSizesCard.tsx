"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";
import { BUTTON, CARD, CardHeading, DiskNote, InstallOutcomeView, InstallProgressView, PRIMARY_BUTTON } from "@/components/local-ai/ui";
import { describeRefusal, useStreamedInstall } from "@/components/local-ai/use-streamed-install";

/**
 * Settings → Local AI → the size this box transcribes with.
 *
 * Whisper arrives as `base` on every box. The other three are one click away
 * (the owner's decision, 2026-09-14) and the card is honest about what the
 * click costs: the download's size against the box's free space, before the
 * button, and the same refusal the route would give if it does not fit.
 *
 * SWAPPING DOES NOT INTERRUPT TRANSCRIPTION. The route fetches the new weights
 * whole before it points the unit at them, so until the download finishes the
 * microphone keeps using the size that is already here — and the restart is a
 * `try-restart`, so an engine that was off stays off. The card says which of
 * those two happened rather than claiming the change is live.
 */

interface SizeRow {
  id: string;
  bytes: number;
  cached: boolean;
  diskBytes: number | null;
}

interface WhisperState {
  installed: boolean;
  running: boolean;
  active: string | null;
  sizes: SizeRow[];
  freeBytes: number | null;
  reserveBytes: number;
}

function isState(value: unknown): value is WhisperState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.installed !== "boolean") return false;
  if (!Array.isArray(v.sizes)) return false;
  return v.sizes.every((s) => {
    const row = s as Record<string, unknown>;
    return typeof row?.id === "string" && typeof row?.bytes === "number" && typeof row?.cached === "boolean";
  });
}

export default function WhisperSizesCard({ onChanged }: { onChanged?: () => void }) {
  const { t, locale } = useT();
  const [state, setState] = useState<WhisperState | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const install = useStreamedInstall();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/whisper", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (isState(data)) setState(data);
    } catch {
      /* keep the last good reading rather than blanking the card */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const use = async (size: string) => {
    setNote(null);
    const ok = await install.run(size, (signal) => fetch("/setup-api/whisper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size }),
      signal,
    }));
    await refresh();
    if (ok) onChanged?.();
  };

  const remove = async (size: string) => {
    setRemoving(size);
    setNote(null);
    install.reset();
    try {
      const res = await fetch(`/setup-api/whisper?size=${encodeURIComponent(size)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(describeRefusal(t, locale, data as Record<string, unknown>));
        return;
      }
      const freed = typeof data?.freedBytes === "number" ? formatBytes(data.freedBytes, locale) : null;
      if (freed) setNote(t("localModels.install.freed", { size: freed }));
      if (isState(data)) setState((prev) => (prev ? { ...prev, ...data } : prev));
      await refresh();
      onChanged?.();
    } catch {
      setNote(t("localModels.error.unreachable"));
    } finally {
      setRemoving(null);
    }
  };

  if (!state) return null;

  return (
    <div className={CARD} data-testid="local-ai-whisper-card">
      <CardHeading title={t("localModels.whisper.title")} hint={t("localModels.whisper.hint")} />
      {!state.installed ? (
        <p className="px-4 pb-4 text-xs text-[var(--text-secondary)]" data-testid="local-ai-whisper-absent">
          {t("localModels.whisper.notInstalled")}
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {state.sizes.map((size) => {
            const active = state.active === size.id;
            const busy = install.busy === size.id;
            const anyBusy = install.busy !== null || removing !== null;
            return (
              <li key={size.id} className="px-4 py-3" data-testid={`local-ai-whisper-${size.id}`}>
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{size.id}</span>
                      {active && (
                        <span
                          className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border text-[var(--coral-bright)] border-[var(--coral-bright)]/40"
                          data-testid={`local-ai-whisper-active-${size.id}`}
                        >
                          {t("localModels.whisper.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                      {size.cached
                        ? t("localModels.disk", { size: formatBytes(size.diskBytes ?? size.bytes, locale) ?? "" })
                        : (
                          <DiskNote
                            requiredBytes={size.bytes}
                            freeBytes={state.freeBytes}
                            locale={locale}
                            testId={`local-ai-whisper-disk-${size.id}`}
                          />
                        )}
                    </p>
                  </div>
                  {!active && (
                    <button
                      type="button"
                      className={PRIMARY_BUTTON}
                      disabled={anyBusy}
                      onClick={() => void use(size.id)}
                      data-testid={`local-ai-whisper-use-${size.id}`}
                    >
                      {busy
                        ? t("localModels.install.downloading")
                        : size.cached ? t("localModels.whisper.use") : t("localModels.install.download")}
                    </button>
                  )}
                  {size.cached && !active && (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={anyBusy}
                      onClick={() => void remove(size.id)}
                      data-testid={`local-ai-whisper-remove-${size.id}`}
                    >
                      {removing === size.id ? t("localModels.install.removing") : t("localModels.install.remove")}
                    </button>
                  )}
                </div>
                {busy && <InstallProgressView progress={install.progress} testId={`local-ai-whisper-progress-${size.id}`} />}
              </li>
            );
          })}
        </ul>
      )}
      <div className="px-4 pb-4">
        <InstallOutcomeView outcome={install.outcome} testId="local-ai-whisper-outcome" />
        {note && (
          <p role="status" className="text-xs text-[var(--text-secondary)] mt-1" data-testid="local-ai-whisper-note">
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
