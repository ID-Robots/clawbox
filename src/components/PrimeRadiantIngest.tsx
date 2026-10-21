"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CARD_SURFACE, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import PrimeRadiantFolderPicker from "./PrimeRadiantFolderPicker";
import { useTokensByRun } from "./PrimeRadiantUsage";
import {
  API,
  PrimeRadiantError,
  errorText,
  formatCount,
  formatTokens,
  formatWhen,
  jsonInit,
  prJson,
  skipEntries,
  type DeadLetter,
  type FileStatus,
  type IngestJob,
  type IngestPreview,
  type SkipCounts,
} from "./prime-radiant-ui";

/** What a drop may carry: the extensions the extractor reads, 9 MiB each (the route's cap). */
const DROP_EXTENSIONS = [".txt", ".md", ".pdf", ".docx", ".odt", ".rtf"];
const DROP_MAX_BYTES = 9 * 1024 * 1024;
const MAX_FOLDERS = 20;
const MAX_FILE_LINES = 50;
/** Above this many documents, Start asks before it spends the owner's allowance. */
export const CONFIRM_ABOVE = 500;
/** The pause after the folder list changes before it is counted again. */
const PREVIEW_DELAY_MS = 300;

/** The preview of the folders in the list, for that exact list. */
interface PreviewState {
  key: string;
  data: IngestPreview | null;
  error: string | null;
}

/** Why the client refuses a dropped file before sending it, or null. */
function dropRefusal(file: { name: string; size: number }): "Type" | "Size" | "Empty" | null {
  const lower = file.name.toLowerCase();
  if (!DROP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "Type";
  if (file.size > DROP_MAX_BYTES) return "Size";
  if (file.size === 0) return "Empty";
  return null;
}

interface FileLine {
  seq: number;
  label: string;
  status: FileStatus;
  reason?: string;
}

/**
 * Ingest: documents into the vault. Folders are picked with the same picker
 * Memory Shard uses; single documents can be dropped (or chosen) here, each
 * uploaded on its own (9 MB at most — larger files go in through their
 * folder). One job runs at a time; its progress streams over SSE, it can be
 * stopped, and whatever still failed after the job's own retry round is its
 * dead-letter list, which one button tries again.
 */
export default function PrimeRadiantIngest({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useT();
  const [folders, setFolders] = useState<string[]>([]);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [running, setRunning] = useState<IngestJob | null>(null);
  const [lines, setLines] = useState<FileLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [deadLetter, setDeadLetter] = useState<DeadLetter[] | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** The folder list Start is asking about (the question lapses when the list changes). */
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadJobs = useCallback(async () => {
    try {
      const answer = await prJson<{ running: string | null; jobs: IngestJob[] }>(`${API}/ingest`);
      setJobs(answer.jobs ?? []);
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [t]);

  const detach = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const finished = useCallback((job: IngestJob) => {
    detach();
    setRunning(null);
    setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)]);
    onChanged();
    void loadJobs();
  }, [detach, onChanged, loadJobs]);

  const startPolling = useCallback((id: string) => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      prJson<{ job: IngestJob }>(`${API}/ingest/${encodeURIComponent(id)}`)
        .then(({ job }) => {
          if (job.status === "running") setRunning(job);
          else finished(job);
        })
        .catch((err) => {
          // The box no longer has the job (its state was wiped): nothing will
          // ever settle it, so stop asking and show the list as it is. Any
          // other failure is a box still coming back — keep polling.
          if (err instanceof PrimeRadiantError && err.status === 404) {
            detach();
            setRunning(null);
            void loadJobs();
          }
        });
    }, 2000);
  }, [finished, detach, loadJobs]);

  /** Follow a job: SSE where the browser has it, a 2 s read of the job otherwise. */
  const follow = useCallback((job: IngestJob) => {
    detach();
    setRunning(job);
    setLines([]);
    if (job.status !== "running") {
      finished(job);
      return;
    }
    if (typeof EventSource !== "undefined") {
      const es = new EventSource(`${API}/ingest/${encodeURIComponent(job.id)}/events`);
      streamRef.current = es;
      es.addEventListener("job", (e) => {
        try { setRunning(JSON.parse((e as MessageEvent).data) as IngestJob); } catch { /* a malformed frame changes nothing */ }
      });
      es.addEventListener("file", (e) => {
        try {
          const line = JSON.parse((e as MessageEvent).data) as FileLine;
          setLines((prev) => [line, ...prev].slice(0, MAX_FILE_LINES));
        } catch { /* ignore */ }
      });
      es.addEventListener("end", (e) => {
        try { finished(JSON.parse((e as MessageEvent).data) as IngestJob); } catch { finished(job); }
      });
      es.onerror = () => {
        // The stream dropped (a restart, a proxy): fall back to reading the job.
        es.close();
        if (streamRef.current === es) streamRef.current = null;
        startPolling(job.id);
      };
      return;
    }
    startPolling(job.id);
  }, [detach, finished, startPolling]);

  useEffect(() => {
    let alive = true;
    prJson<{ running: string | null; jobs: IngestJob[] }>(`${API}/ingest`)
      .then((answer) => {
        if (!alive) return;
        setJobs(answer.jobs ?? []);
        const job = answer.running ? answer.jobs.find((j) => j.id === answer.running) : undefined;
        if (job) follow(job);
      })
      .catch((err) => { if (alive) setError(errorText(err, t)); });
    return () => {
      alive = false;
      detach();
    };
  }, [follow, detach, t]);

  // Count what the chosen folders would read, again whenever the list changes.
  const folderKey = JSON.stringify(folders);
  useEffect(() => {
    const list = JSON.parse(folderKey) as string[];
    if (list.length === 0) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      prJson<{ preview: IngestPreview }>(`${API}/ingest/preview`, { ...jsonInit("POST", { folders: list }), signal: ctl.signal })
        .then(({ preview: data }) => setPreview({ key: folderKey, data, error: null }))
        .catch((err) => {
          if ((err as Error)?.name === "AbortError") return;
          setPreview({ key: folderKey, data: null, error: errorText(err, t) });
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [folderKey, t]);
  // A preview counts only for the list it was made for.
  const current = folders.length > 0 && preview && preview.key === folderKey ? preview : null;
  const counting = folders.length > 0 && !current;
  const confirming = confirmFor === folderKey;

  const start = async (body: unknown, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const { job } = await prJson<{ job: IngestJob }>(`${API}/ingest`, jsonInit("POST", body));
      follow(job);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!running) return;
    setBusy("stop");
    setError(null);
    try {
      await prJson(`${API}/ingest/${encodeURIComponent(running.id)}`, { method: "DELETE" });
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (id: string) => {
    setBusy(`retry-${id}`);
    setError(null);
    try {
      const { job } = await prJson<{ job: IngestJob }>(`${API}/ingest/${encodeURIComponent(id)}/retry`, jsonInit("POST", {}));
      setOpenJob(null);
      follow(job);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  const showDeadLetter = async (id: string) => {
    if (openJob === id) {
      setOpenJob(null);
      return;
    }
    setOpenJob(id);
    setDeadLetter(null);
    try {
      const answer = await prJson<{ deadLetter: DeadLetter[] }>(`${API}/ingest/${encodeURIComponent(id)}`);
      setDeadLetter(answer.deadLetter ?? []);
    } catch (err) {
      setError(errorText(err, t));
    }
  };

  /** Each file on its own upload; the first answer names the batch the rest join. */
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0 || busy || running) return;
    setError(null);
    setUploadNote(null);
    const accepted: File[] = [];
    const refused: string[] = [];
    for (const f of files) {
      const why = dropRefusal(f);
      if (why) refused.push(t(`primeRadiant.ingest.refused${why}`, { name: f.name }));
      else accepted.push(f);
    }
    if (refused.length > 0) setUploadNote(refused.join(" "));
    if (accepted.length === 0) return;
    setBusy("upload");
    let batch: string | null = null;
    try {
      for (const [i, file] of accepted.entries()) {
        setUploadNote(t("primeRadiant.ingest.uploading", { done: i, total: accepted.length }));
        const q = new URLSearchParams({ name: file.name });
        if (batch) q.set("batch", batch);
        const answer = await prJson<{ batch: string }>(`${API}/ingest/upload?${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        batch = answer.batch;
      }
      setUploadNote(refused.length > 0 ? refused.join(" ") : null);
      const { job } = await prJson<{ job: IngestJob }>(`${API}/ingest`, jsonInit("POST", { upload: batch }));
      follow(job);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  /** Start, after asking when the folders hold many documents (or could not be counted). */
  const startFolders = () => {
    const documents = current?.data?.documents;
    if (!confirming && (documents === undefined || documents > CONFIRM_ABOVE)) {
      setConfirmFor(folderKey);
      return;
    }
    setConfirmFor(null);
    void start({ folders }, "folders");
  };

  // Tokens per job: read again as the list changes, and every 5 s while a job runs.
  const tokensByRun = useTokensByRun(jobs, running ? 5000 : 0);
  const tokens = (id: string) => {
    const n = tokensByRun?.get(id) ?? 0;
    return n > 0 ? t("primeRadiant.tokens", { n: formatTokens(n, locale) }) : null;
  };

  const percent = running && running.total > 0
    ? Math.min(100, Math.round(((running.done + running.failed + running.skipped + running.duplicates) / running.total) * 100))
    : null;

  return (
    <div className="space-y-4" data-testid="prime-radiant-ingest">
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}

      {running && (
        <section className={`${CARD_SURFACE} p-4 space-y-2`} data-testid="prime-radiant-ingest-running" data-status={running.status}>
          <div className="flex items-center justify-between gap-2">
            <h3 className={SECTION_LABEL}>{t("primeRadiant.ingest.running")}</h3>
            <button type="button" className={BTN_DANGER} onClick={() => void stop()} disabled={busy === "stop"} data-testid="prime-radiant-ingest-stop">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">stop</span>
              {busy === "stop" ? t("primeRadiant.ingest.stopping") : t("primeRadiant.ingest.stop")}
            </button>
          </div>
          <div
            className="h-1.5 rounded-full bg-white/10 overflow-hidden"
            role="progressbar"
            aria-label={t("primeRadiant.ingest.progress")}
            aria-valuemin={percent === null ? undefined : 0}
            aria-valuemax={percent === null ? undefined : 100}
            aria-valuenow={percent ?? undefined}
          >
            {percent === null
              ? <div className="memory-index-bar-sweep bg-emerald-400/70" />
              : <div className="h-full bg-emerald-400/80 transition-[width] duration-500" style={{ width: `${percent}%` }} />}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            {t(`primeRadiant.ingest.phase.${running.phase}`)} · {t("primeRadiant.ingest.tally", {
              done: running.done, total: running.total, failed: running.failed, skipped: running.skipped + running.duplicates, pages: running.pages,
            })}
            {tokens(running.id) && <span data-testid="prime-radiant-ingest-tokens"> · {tokens(running.id)}</span>}
          </p>
          <SkipLine skips={running.skips} testId="prime-radiant-ingest-skips" />
          {lines.length > 0 && (
            <ul className={`${INSET_SURFACE} max-h-40 overflow-y-auto p-2 space-y-0.5 font-mono text-[11px]`} data-testid="prime-radiant-ingest-files">
              {lines.map((l) => (
                <li key={`${l.seq}:${l.status}`} className={l.status === "failed" ? "text-red-300" : l.status === "done" ? "text-emerald-300" : "text-[var(--text-muted)]"}>
                  {t(`primeRadiant.ingest.file.${l.status}`)} · {l.label}{l.reason ? ` — ${l.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={`${CARD_SURFACE} p-4 space-y-3`}>
        <h3 className={SECTION_LABEL}>{t("primeRadiant.ingest.foldersTitle")}</h3>
        <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.ingest.foldersBody")}</p>
        <PrimeRadiantFolderPicker folders={folders} onChange={setFolders} max={MAX_FOLDERS} disabled={busy !== null} testId="prime-radiant-ingest-folders" />
        {counting && (
          <div className={`${INSET_SURFACE} p-3 space-y-2`} role="status" data-testid="prime-radiant-ingest-preview" data-state="counting">
            <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.ingest.previewCounting")}</p>
            <div className="h-1 rounded-full bg-white/10 overflow-hidden"><div className="memory-index-bar-sweep bg-emerald-400/70" /></div>
          </div>
        )}
        {current?.error && (
          <p role="alert" className="text-xs text-red-300" data-testid="prime-radiant-ingest-preview" data-state="failed">
            {current.error}
          </p>
        )}
        {current?.data && <PreviewCard preview={current.data} />}
        {confirming ? (
          <div className={`${INSET_SURFACE} p-3 space-y-2 border border-amber-300/30`} role="alertdialog" aria-labelledby="pr-ingest-confirm" data-testid="prime-radiant-ingest-confirm">
            <p id="pr-ingest-confirm" className="text-xs text-amber-100">
              {current?.data
                ? t("primeRadiant.ingest.confirmTitle", { n: formatCount(current.data.documents, locale) })
                : t("primeRadiant.ingest.confirmUnknown")}
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.ingest.confirmBody")}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN_PRIMARY} disabled={busy !== null || !!running} onClick={startFolders} data-testid="prime-radiant-ingest-confirm-start">
                {busy === "folders" ? t("primeRadiant.ingest.starting") : t("primeRadiant.ingest.confirmStart")}
              </button>
              <button type="button" className={BTN_SECONDARY} onClick={() => setConfirmFor(null)} data-testid="prime-radiant-ingest-confirm-cancel">
                {t("primeRadiant.ingest.confirmCancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={folders.length === 0 || counting || current?.data?.documents === 0 || busy !== null || !!running}
            onClick={startFolders}
            data-testid="prime-radiant-ingest-start"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">drive_folder_upload</span>
            {busy === "folders" ? t("primeRadiant.ingest.starting") : t("primeRadiant.ingest.start")}
          </button>
        )}
      </section>

      <section
        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${dragging ? "border-[var(--coral-bright)] bg-white/[0.04]" : "border-white/[0.12]"}`}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          void uploadFiles(Array.from(e.dataTransfer.files ?? []));
        }}
        data-testid="prime-radiant-dropzone"
      >
        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 28 }} aria-hidden="true">upload_file</span>
        <p className="mt-1 text-sm text-[var(--text-primary)]">{t("primeRadiant.ingest.dropTitle")}</p>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t("primeRadiant.ingest.dropBody")}</p>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={DROP_EXTENSIONS.join(",")}
          className="sr-only"
          aria-label={t("primeRadiant.ingest.choose")}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void uploadFiles(files);
          }}
          data-testid="prime-radiant-file-input"
        />
        <button type="button" className={`${BTN_SECONDARY} mt-3`} disabled={busy !== null || !!running} onClick={() => fileInput.current?.click()}>
          {busy === "upload" ? t("primeRadiant.ingest.uploadingShort") : t("primeRadiant.ingest.choose")}
        </button>
        {uploadNote && <p role="status" className="mt-2 text-[11px] text-amber-200">{uploadNote}</p>}
      </section>

      <section className="space-y-2">
        <h3 className={SECTION_LABEL}>{t("primeRadiant.ingest.recent")}</h3>
        {jobs.length === 0 && <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.ingest.noJobs")}</p>}
        <ul className="space-y-1.5" data-testid="prime-radiant-ingest-jobs">
          {jobs.map((job) => (
            <li key={job.id} className={`${INSET_SURFACE} px-3 py-2`} data-testid="prime-radiant-ingest-job">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[var(--text-primary)]">{t(`primeRadiant.ingest.status.${job.status}`)}</span>
                <span className="text-[var(--text-muted)]">{formatWhen(job.createdAt, locale)}</span>
                <span className="text-[var(--text-muted)]">
                  {t("primeRadiant.ingest.jobSummary", { pages: job.pages, done: job.done, total: job.total })}
                  {tokens(job.id) && ` · ${tokens(job.id)}`}
                </span>
                {/* What a spent allowance left queued is retried with the dead letters, but never counted as one. */}
                {(job.deadLetter > 0 || (job.queued ?? 0) > 0) && (
                  <button type="button" className={`${BTN_SECONDARY} ml-auto`} onClick={() => void showDeadLetter(job.id)} aria-expanded={openJob === job.id} data-testid="prime-radiant-dead-letter-toggle">
                    {[
                      job.deadLetter > 0 ? t("primeRadiant.ingest.deadLetter", { n: job.deadLetter }) : null,
                      (job.queued ?? 0) > 0 ? t("primeRadiant.ingest.queued", { n: job.queued }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </button>
                )}
              </div>
              {job.folders.length > 0 && <p className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)] truncate">{job.folders.join(", ")}</p>}
              <SkipLine skips={job.skips} testId="prime-radiant-ingest-job-skips" />
              {job.error && <p className="mt-0.5 text-[11px] text-red-300">{job.error}</p>}
              {openJob === job.id && (
                <div className="mt-2 space-y-2" data-testid="prime-radiant-dead-letter">
                  {deadLetter === null ? (
                    <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.loading")}</p>
                  ) : (
                    <ul className="space-y-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                      {deadLetter.map((d) => (
                        <li key={d.seq} className="break-all">{d.label}{d.error ? ` — ${d.error}` : ""}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className={BTN_SECONDARY}
                    disabled={busy !== null || !!running}
                    onClick={() => void retry(job.id)}
                    data-testid="prime-radiant-dead-letter-retry"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">replay</span>
                    {busy === `retry-${job.id}` ? t("primeRadiant.ingest.starting") : t("primeRadiant.ingest.retry")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** What a job or a preview left out, by reason: one muted line, nothing when nothing was left out. */
function SkipLine({ skips, testId }: { skips: Partial<SkipCounts> | null | undefined; testId: string }) {
  const { t, locale } = useT();
  const entries = skipEntries(skips);
  if (entries.length === 0) return null;
  return (
    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]" data-testid={testId}>
      {t("primeRadiant.ingest.leftOut")}{" "}
      {entries.map(([reason, n]) => t(`primeRadiant.ingest.skip.${reason}`, { n: formatCount(n, locale) })).join(" · ")}
    </p>
  );
}

/** The chosen folders, counted: what Start would read, where it is, and what is left out and why. */
function PreviewCard({ preview }: { preview: IngestPreview }) {
  const { t, locale } = useT();
  const entries = skipEntries(preview.skips);
  return (
    <div className={`${INSET_SURFACE} p-3 space-y-2`} data-testid="prime-radiant-ingest-preview" data-state="ready" data-documents={preview.documents}>
      <p className="text-xs text-[var(--text-primary)]">
        {preview.documents === 0
          ? t("primeRadiant.ingest.previewNone")
          : t("primeRadiant.ingest.previewDocuments", { n: formatCount(preview.documents, locale) })}
      </p>
      {preview.truncated && (
        <p className="text-[11px] text-amber-200">{t("primeRadiant.ingest.previewTruncated", { max: formatCount(preview.limit, locale) })}</p>
      )}
      {preview.topFolders.length > 0 && (
        <div>
          <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.ingest.previewTopFolders")}</p>
          <ul className="mt-1 space-y-0.5" data-testid="prime-radiant-ingest-preview-folders">
            {preview.topFolders.map((f) => (
              <li key={f.label} className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-secondary)]">
                <span className="flex-1 truncate">{f.label}</span>
                <span className="tabular-nums text-[var(--text-muted)]">{formatCount(f.documents, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {entries.length > 0 && (
        <div>
          <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.ingest.leftOut")}</p>
          <ul className="mt-1 space-y-0.5" data-testid="prime-radiant-ingest-preview-skips">
            {entries.map(([reason, n]) => (
              <li key={reason} className="text-[11px] text-[var(--text-secondary)]" data-reason={reason}>
                {t(`primeRadiant.ingest.skip.${reason}`, { n: formatCount(n, locale) })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.codeProjects.length > 0 && (
        <details className="text-[11px] text-[var(--text-muted)]">
          <summary className="cursor-pointer">{t("primeRadiant.ingest.previewProjects", { n: formatCount(preview.skips.codeProject, locale) })}</summary>
          <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5 font-mono">
            {preview.codeProjects.map((p) => <li key={p} className="truncate">{p}</li>)}
          </ul>
          <p className="mt-1">{t("primeRadiant.ingest.previewProjectsHelp")}</p>
        </details>
      )}
      {preview.notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-amber-200/80">
          {preview.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
