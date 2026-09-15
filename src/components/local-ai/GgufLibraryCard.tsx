"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useT } from "@/lib/i18n";
import { isHfGgufFile, isHfRepo } from "@/lib/local-install";
import { BUTTON, CARD, CardHeading, INPUT, InstallOutcomeView, InstallProgressView, PRIMARY_BUTTON } from "@/components/local-ai/ui";
import { describeRefusal, useStreamedInstall } from "@/components/local-ai/use-streamed-install";

/**
 * Settings → Local AI → any other llama.cpp model.
 *
 * The owner names a Hugging Face repository and a `.gguf` inside it, presses
 * Check, is told what it weighs and whether it fits, and only then is offered
 * Download. The check is not decoration: a GGUF is gigabytes, and the one
 * refusal that has to arrive BEFORE the download is "this will not fit".
 *
 * WHAT THE CARD DOES NOT CLAIM. Fetching a model puts it in this box's
 * library; it does not make the box answer with it. `llama-server` is started
 * from one model path resolved out of the environment when the web server
 * starts, so switching which GGUF is served is a change to the chat path and
 * not to a button here. The hint says exactly that rather than leaving the
 * owner to discover it.
 */

interface LibraryFile {
  name: string;
  bytes: number | null;
  inUse: boolean;
}

interface Library {
  files: LibraryFile[];
  defaultFile: string;
  downloaderReady: boolean;
  freeBytes: number | null;
}

interface Probe {
  bytes: number | null;
  probe: string;
  alreadyHere: boolean;
  fits: boolean | null;
}

function isLibrary(value: unknown): value is Library {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.files) && typeof v.defaultFile === "string";
}

export default function GgufLibraryCard() {
  const { t, locale } = useT();
  const [library, setLibrary] = useState<Library | null>(null);
  const [repo, setRepo] = useState("");
  const [file, setFile] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const install = useStreamedInstall();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/llamacpp/models", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (isLibrary(data)) setLibrary(data);
    } catch {
      /* keep the last good reading */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Validated on THIS side with the same module the route validates with, so a
  // typo is answered instantly instead of costing a round trip.
  const named = isHfRepo(repo.trim()) && isHfGgufFile(file.trim());

  const clearProbe = () => {
    setProbe(null);
    setNote(null);
    install.reset();
  };

  const check = async () => {
    setChecking(true);
    setNote(null);
    install.reset();
    try {
      const res = await fetch(
        `/setup-api/llamacpp/models?repo=${encodeURIComponent(repo.trim())}&file=${encodeURIComponent(file.trim())}`,
        { cache: "no-store" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProbe(null);
        setNote(describeRefusal(t, locale, data as Record<string, unknown>));
        return;
      }
      setProbe(data as Probe);
    } catch {
      setProbe(null);
      setNote(t("localModels.error.unreachable"));
    } finally {
      setChecking(false);
    }
  };

  const download = async () => {
    setNote(null);
    const ok = await install.run("download", (signal) => fetch("/setup-api/llamacpp/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repo.trim(), file: file.trim() }),
      signal,
    }));
    await refresh();
    if (ok) {
      setProbe(null);
      setRepo("");
      setFile("");
    }
  };

  const remove = async (name: string) => {
    setRemoving(name);
    setNote(null);
    install.reset();
    try {
      const res = await fetch(`/setup-api/llamacpp/models?file=${encodeURIComponent(name)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(describeRefusal(t, locale, data as Record<string, unknown>));
        return;
      }
      const freed = typeof data?.freedBytes === "number" ? formatBytes(data.freedBytes, locale) : null;
      if (freed) setNote(t("localModels.install.freed", { size: freed }));
      await refresh();
    } catch {
      setNote(t("localModels.error.unreachable"));
    } finally {
      setRemoving(null);
    }
  };

  if (!library) return null;
  const busy = install.busy !== null || removing !== null || checking;
  const probeSize = probe ? formatBytes(probe.bytes, locale) : null;
  const free = formatBytes(library.freeBytes, locale);

  return (
    <div className={CARD} data-testid="local-ai-gguf-card">
      <CardHeading title={t("localModels.gguf.title")} hint={t("localModels.gguf.hint")} />

      {library.files.length > 0 && (
        <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {library.files.map((entry) => (
            <li key={entry.name} className="px-4 py-3 flex items-center gap-3" data-testid={`local-ai-gguf-file-${entry.name}`}>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text-primary)] break-all">{entry.name}</p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {formatBytes(entry.bytes, locale) ?? ""}
                  {entry.inUse ? ` · ${t("localModels.gguf.inUse")}` : ""}
                </p>
              </div>
              {!entry.inUse && (
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => void remove(entry.name)}
                  data-testid={`local-ai-gguf-remove-${entry.name}`}
                >
                  {removing === entry.name ? t("localModels.install.removing") : t("localModels.install.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="px-4 py-3 border-t border-white/[0.06] space-y-2">
        {!library.downloaderReady && (
          <p className="text-xs text-amber-300" data-testid="local-ai-gguf-no-downloader">
            {t("localModels.gguf.noDownloader")}
          </p>
        )}
        <label className="block">
          <span className="text-xs text-[var(--text-secondary)]">{t("localModels.gguf.repo")}</span>
          <input
            type="text"
            value={repo}
            onChange={(e) => { setRepo(e.target.value); clearProbe(); }}
            placeholder="owner/name"
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
            data-testid="local-ai-gguf-repo"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[var(--text-secondary)]">{t("localModels.gguf.file")}</span>
          <input
            type="text"
            value={file}
            onChange={(e) => { setFile(e.target.value); clearProbe(); }}
            placeholder="model-q4_0.gguf"
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
            data-testid="local-ai-gguf-file"
          />
        </label>

        {(repo.trim() || file.trim()) && !named && (
          <p className="text-xs text-amber-300" data-testid="local-ai-gguf-invalid">{t("localModels.gguf.invalid")}</p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className={BUTTON}
            disabled={!named || busy}
            onClick={() => void check()}
            data-testid="local-ai-gguf-check"
          >
            {checking ? t("localModels.install.working") : t("localModels.gguf.check")}
          </button>
          {probe && probe.probe === "ok" && !probe.alreadyHere && (
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={busy || !library.downloaderReady || probe.fits === false}
              onClick={() => void download()}
              data-testid="local-ai-gguf-download"
            >
              {install.busy ? t("localModels.install.downloading") : t("localModels.install.download")}
            </button>
          )}
        </div>

        {probe && (
          <p className="text-xs text-[var(--text-secondary)]" data-testid="local-ai-gguf-probe">
            {probe.alreadyHere
              ? t("localModels.gguf.alreadyHere")
              : probe.probe === "not_found"
                ? t("localModels.gguf.notFound")
                : probe.probe === "no_such_file"
                  ? t("localModels.gguf.noSuchFile")
                  : probeSize
                    ? probe.fits === false
                      ? t("localModels.install.diskShort", { need: probeSize, free: free ?? "" })
                      : t("localModels.gguf.size", { size: probeSize, free: free ?? "" })
                    : t("localModels.gguf.sizeUnknown")}
          </p>
        )}

        <InstallProgressView progress={install.progress} testId="local-ai-gguf-progress" />
        <InstallOutcomeView outcome={install.outcome} testId="local-ai-gguf-outcome" />
        {note && (
          <p role="status" className="text-xs text-[var(--text-secondary)]" data-testid="local-ai-gguf-note">{note}</p>
        )}
      </div>
    </div>
  );
}
