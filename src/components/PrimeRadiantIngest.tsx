"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CARD_SURFACE, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import PrimeRadiantFolderPicker from "./PrimeRadiantFolderPicker";
import {
  API,
  PrimeRadiantError,
  errorText,
  formatUsd,
  formatWhen,
  jsonInit,
  prJson,
  type DeadLetter,
  type FileStatus,
  type IngestJob,
} from "./prime-radiant-ui";

/** What a drop may carry: the extensions the extractor reads, 9 MiB each (the route's cap). */
const DROP_EXTENSIONS = [".txt", ".md", ".pdf", ".docx", ".odt", ".rtf"];
const DROP_MAX_BYTES = 9 * 1024 * 1024;
const MAX_FOLDERS = 20;
const MAX_FILE_LINES = 50;

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
          </p>
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
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={folders.length === 0 || busy !== null || !!running}
          onClick={() => void start({ folders }, "folders")}
          data-testid="prime-radiant-ingest-start"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">drive_folder_upload</span>
          {busy === "folders" ? t("primeRadiant.ingest.starting") : t("primeRadiant.ingest.start")}
        </button>
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
                  {t("primeRadiant.ingest.jobSummary", { pages: job.pages, done: job.done, total: job.total, usd: formatUsd(job.usdEstimate, locale) })}
                </span>
                {job.deadLetter > 0 && (
                  <button type="button" className={`${BTN_SECONDARY} ml-auto`} onClick={() => void showDeadLetter(job.id)} aria-expanded={openJob === job.id} data-testid="prime-radiant-dead-letter-toggle">
                    {t("primeRadiant.ingest.deadLetter", { n: job.deadLetter })}
                  </button>
                )}
              </div>
              {job.folders.length > 0 && <p className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)] truncate">{job.folders.join(", ")}</p>}
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
