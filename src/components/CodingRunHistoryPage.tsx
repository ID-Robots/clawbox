"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { renderText } from "@/lib/chat-markdown";
import type { ArchiveEntry, ArchivedRunDetail } from "@/lib/coding-run-history";
import type { CodingRunStatus } from "@/lib/coding-agent-status";
import { RUN_TONE } from "./RunProgressBar";
import StatusMessage from "./StatusMessage";
import { BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, INSET_SURFACE, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";

/**
 * The Coding Agent's Run history page (TASK-1178): the runs the box keeps past
 * the newest thirty, in two lists.
 *
 *  - Older runs — kept by the Extended and Keep everything modes. Their
 *    evidence never moved, so a row opens the ordinary run page (`onOpenRun`).
 *  - Archived runs — moved into the archive by the Archive mode. Read-only
 *    here, one run at a time, each with its own .zip.
 *
 * Both are paged from the server; neither list is ever in the runs file.
 */

/** The fields of a run record this page draws. The server sends the whole record. */
export interface OlderRunRow {
  id: string;
  task: string;
  status: CodingRunStatus;
  startedAt: number;
  completedAt: number | null;
  directory: string;
  numTurns: number;
  filesTouched: string[];
  reviewOf?: string | null;
}

const PAGE = 20;

/** CodingRunSummary's prose styling, so an archived summary reads like a live one. */
const SUMMARY_PROSE = "text-xs text-[var(--text-secondary)] leading-relaxed min-w-0 break-words [&_img]:max-w-full [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--text-primary)] [&_h1]:mt-2 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_h2]:mt-2 [&_h3]:font-semibold [&_h3]:text-[var(--text-primary)] [&_h3]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_code]:font-mono";

type Tab = "older" | "archived";

function firstLine(text: string, max: number): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function projectName(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

export function archivedFileUrl(runId: string, name: string): string {
  return `/setup-api/coding-agent/history/file?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(name)}`;
}

export function archivedRunZipUrl(runId: string): string {
  return `/setup-api/coding-agent/history/export?runId=${encodeURIComponent(runId)}`;
}

export default function CodingRunHistoryPage({
  onOpenRun,
  initialArchivedId = null,
  liveKept = 30,
}: {
  /** Open an older run on the app's own run page. */
  onOpenRun: (run: OlderRunRow) => void;
  /** Open straight onto this archived run (a card for a run the archive now holds). */
  initialArchivedId?: string | null;
  /** Runs the live list holds — what the empty lists say is kept anyway. */
  liveKept?: number;
}) {
  const { t, locale } = useT();
  const [tab, setTab] = useState<Tab | null>(initialArchivedId ? "archived" : null);
  const [older, setOlder] = useState<{ runs: OlderRunRow[]; total: number } | null>(null);
  const [archived, setArchived] = useState<{ entries: ArchiveEntry[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialArchivedId);
  const [detail, setDetail] = useState<ArchivedRunDetail | null>(null);
  const [detailMissing, setDetailMissing] = useState(false);

  const fetchOlder = useCallback(async (offset: number) => {
    // With the evidence listing: a row opens the ordinary run page, which draws it.
    const res = await fetch(`/setup-api/coding-agent/runs?history=1&offset=${offset}&limit=${PAGE}&artifacts=1`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json() as { runs: OlderRunRow[]; total: number };
  }, []);
  const fetchArchived = useCallback(async (offset: number) => {
    const res = await fetch(`/setup-api/coding-agent/history?view=archive&offset=${offset}&limit=${PAGE}`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json() as { entries: ArchiveEntry[]; total: number };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchOlder(0), fetchArchived(0)]).then(([o, a]) => {
      if (cancelled) return;
      setOlder(o);
      setArchived(a);
      // The list with something in it, the older runs when both have.
      setTab((current) => current ?? (o.total === 0 && a.total > 0 ? "archived" : "older"));
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [fetchOlder, fetchArchived]);

  useEffect(() => {
    if (!openId) { setDetail(null); setDetailMissing(false); return; }
    let cancelled = false;
    setDetail(null);
    setDetailMissing(false);
    void fetch(`/setup-api/coding-agent/history?view=archive&id=${encodeURIComponent(openId)}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setDetailMissing(true); return; }
        setDetail((await res.json() as { run: ArchivedRunDetail }).run);
      })
      .catch(() => { if (!cancelled) setDetailMissing(true); });
    return () => { cancelled = true; };
  }, [openId]);

  const more = async () => {
    setBusy(true);
    try {
      if (tab === "older" && older) {
        const next = await fetchOlder(older.runs.length);
        setOlder({ runs: [...older.runs, ...next.runs], total: next.total });
      } else if (tab === "archived" && archived) {
        const next = await fetchArchived(archived.entries.length);
        setArchived({ entries: [...archived.entries, ...next.entries], total: next.total });
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");
  const bytes = (n: number | null | undefined) => formatBytes(n ?? null, locale) ?? "0 B";
  const statusLabel = (s: string) => (s === "gave_up"
    ? t("codingAgent.statusGaveUp")
    : s ? t(`codingAgent.status${s.charAt(0).toUpperCase()}${s.slice(1)}`) : "—");
  const chip = (s: string) => (
    <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${RUN_TONE[s as CodingRunStatus]?.chip ?? "text-[var(--text-muted)] border-white/20"}`}>
      {statusLabel(s)}
    </span>
  );

  // ─── One archived run ──────────────────────────────────────────────────────
  if (openId) {
    const record = detail?.record as Record<string, unknown> | undefined;
    const summary = typeof record?.resultText === "string" && record.resultText
      ? record.resultText
      : typeof record?.summary === "string" ? record.summary : "";
    const runError = typeof record?.error === "string" ? record.error : "";
    const progress = Array.isArray(record?.progress) ? (record.progress as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const progressAt = Array.isArray(record?.progressAt) ? (record.progressAt as unknown[]) : [];
    const files = Array.isArray(record?.filesTouched) ? (record.filesTouched as unknown[]).filter((f): f is string => typeof f === "string") : [];
    const task = typeof record?.task === "string" ? record.task : "";
    const images = detail?.evidence.filter((e) => e.kind === "image") ?? [];
    const others = detail?.evidence.filter((e) => e.kind !== "image") ?? [];
    return (
      <div className="mt-3 pb-6" data-testid="coding-agent-archived-run">
        <button type="button" onClick={() => setOpenId(null)} className={BTN_QUIET} data-testid="coding-agent-archived-back">
          <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">arrow_back</span>
          {t("codingAgent.history.tabArchived")}
        </button>
        {detailMissing && (
          <div className="mt-3"><StatusMessage type="error" message={t("codingAgent.history.notFound")} /></div>
        )}
        {!detail && !detailMissing && (
          <div className={`${CARD_SURFACE} h-24 mt-3 motion-safe:animate-pulse`} />
        )}
        {detail && (
          <div className="mt-3 space-y-3">
            <div className={`${CARD_SURFACE} px-4 py-3`}>
              <div className="flex flex-wrap items-center gap-2">
                {chip(detail.entry.status)}
                <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--text-muted)] border-white/20" data-testid="coding-agent-archived-readonly">
                  {t("codingAgent.history.readOnly")}
                </span>
                <span className="text-[11px] font-mono text-[var(--text-muted)]">{detail.entry.id}</span>
                <a href={archivedRunZipUrl(detail.entry.id)} download className={`${BTN_SECONDARY} ml-auto`} data-testid="coding-agent-archived-export">
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">folder_zip</span>
                  {t("codingAgent.history.exportRun")}
                </a>
              </div>
              <h2 className="mt-2 text-sm font-semibold text-[var(--text-primary)] break-words" data-testid="coding-agent-archived-title">
                {detail.entry.title || firstLine(task, 120)}
              </h2>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
                <dt className="text-[var(--text-muted)]">{t("codingAgent.history.detailStarted")}</dt>
                <dd className="text-[var(--text-secondary)]">{when(detail.entry.startedAt)}</dd>
                <dt className="text-[var(--text-muted)]">{t("codingAgent.history.detailFinished")}</dt>
                <dd className="text-[var(--text-secondary)]">{when(detail.entry.completedAt)}</dd>
                <dt className="text-[var(--text-muted)]">{t("codingAgent.history.detailArchived")}</dt>
                <dd className="text-[var(--text-secondary)]">{when(detail.entry.archivedAt)}</dd>
                <dt className="text-[var(--text-muted)]">{t("codingAgent.history.detailProject")}</dt>
                <dd className="text-[var(--text-secondary)] font-mono break-all">{detail.entry.project || detail.entry.directory}</dd>
                <dt className="text-[var(--text-muted)]">{t("codingAgent.history.detailSize")}</dt>
                <dd className="text-[var(--text-secondary)]">{bytes(detail.entry.bytes)}</dd>
              </dl>
            </div>

            {task && (
              <section className={`${CARD_SURFACE} px-4 py-3`}>
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailTask")}</h3>
                <p className="mt-1.5 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{task}</p>
              </section>
            )}

            {(summary || runError) && (
              <section className={`${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-archived-summary">
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailSummary")}</h3>
                {runError && <p className="mt-1.5 text-xs text-red-300 whitespace-pre-wrap break-words">{runError}</p>}
                {/* Drawn the way the live run page draws its summary: the chat's
                    own Markdown renderer, which builds React elements and never
                    injects HTML — this text is the run's own output. */}
                {summary && (
                  <div className={`mt-1.5 max-h-72 overflow-y-auto ${SUMMARY_PROSE}`}>
                    {renderText(summary, t("chat.table"))}
                  </div>
                )}
              </section>
            )}

            <section className={`${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-archived-evidence">
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailEvidence")}</h3>
              {detail.evidence.length === 0 ? (
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.history.noEvidence")}</p>
              ) : (
                <>
                  {images.length > 0 && (
                    <div className="mt-2 grid grid-cols-2 @md:grid-cols-3 gap-2">
                      {images.map((f) => (
                        <a key={f.name} href={archivedFileUrl(detail.entry.id, f.name)} target="_blank" rel="noreferrer" title={`${f.name} · ${bytes(f.bytes)}`} className="block rounded-lg border border-white/10 overflow-hidden hover:border-white/25 bg-black/30">
                          {/* eslint-disable-next-line @next/next/no-img-element -- a box-local file behind a session, not an optimisable asset */}
                          <img src={archivedFileUrl(detail.entry.id, f.name)} alt={f.name} loading="lazy" className="w-full h-28 object-cover" />
                        </a>
                      ))}
                    </div>
                  )}
                  {others.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {others.map((f) => (
                        <li key={f.name} className="flex items-center justify-between gap-2 text-[11px]">
                          <a href={archivedFileUrl(detail.entry.id, f.name)} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline break-all">{f.name}</a>
                          <span className="text-[var(--text-muted)] shrink-0">{bytes(f.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>

            {detail.inputs.length > 0 && (
              <section className={`${CARD_SURFACE} px-4 py-3`}>
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailInputs")}</h3>
                <ul className="mt-1.5 space-y-1">
                  {detail.inputs.map((f) => (
                    <li key={f.name} className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
                      <span className="break-all">{f.name}</span>
                      <span className="text-[var(--text-muted)] shrink-0">{bytes(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {files.length > 0 && (
              <section className={`${CARD_SURFACE} px-4 py-3`}>
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailFiles")}</h3>
                <ul className="mt-1.5 space-y-0.5 max-h-48 overflow-y-auto">
                  {files.map((f) => <li key={f} className="text-[11px] font-mono text-[var(--text-secondary)] break-all">{f}</li>)}
                </ul>
              </section>
            )}

            {progress.length > 0 && (
              <section className={`${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-archived-activity">
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailActivity")}</h3>
                <ol className="mt-1.5 space-y-0.5 max-h-72 overflow-y-auto">
                  {progress.map((line, i) => {
                    const at = typeof progressAt[i] === "number" ? progressAt[i] as number : null;
                    return (
                      <li key={i} className="text-[11px] text-[var(--text-secondary)] break-words">
                        {at !== null && <span className="text-[var(--text-muted)] font-mono mr-2">{new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>}
                        {line}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            <section className={`${INSET_SURFACE} px-4 py-3`} data-testid="coding-agent-archived-transcript">
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.history.detailTranscript")}</h3>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                {detail.transcriptBytes !== null
                  ? t("codingAgent.history.transcriptIncluded", { size: bytes(detail.transcriptBytes) })
                  : t("codingAgent.history.transcriptMissing")}
              </p>
            </section>
          </div>
        )}
      </div>
    );
  }

  // ─── The two lists ─────────────────────────────────────────────────────────
  const shown = tab === "archived" ? archived?.entries.length ?? 0 : older?.runs.length ?? 0;
  const total = tab === "archived" ? archived?.total ?? 0 : older?.total ?? 0;
  return (
    <div className="mt-3 pb-6" data-testid="coding-agent-history-page">
      <div className={SEGMENTED_TRACK} role="tablist" aria-label={t("codingAgent.history.title")}>
        {(["older", "archived"] as const).map((key) => {
          const count = key === "older" ? older?.total : archived?.total;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              data-testid={`coding-agent-history-tab-${key}`}
              className={tab === key ? SEGMENT_ON : SEGMENT_OFF}
            >
              {key === "older" ? t("codingAgent.history.tabOlder") : t("codingAgent.history.tabArchived")}
              {typeof count === "number" && <span className="text-[var(--text-muted)]">({count})</span>}
            </button>
          );
        })}
      </div>

      {failed && <div className="mt-3"><StatusMessage type="error" message={t("codingAgent.history.loadFailed")} /></div>}

      {tab === null && !failed && <div className={`${CARD_SURFACE} h-24 mt-3 motion-safe:animate-pulse`} />}

      {tab === "older" && older && (
        older.runs.length === 0 ? (
          <p className="mt-4 px-1 text-xs text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-history-older-empty">
            {t("codingAgent.history.olderEmpty", { count: liveKept })}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2" data-testid="coding-agent-history-older">
            {older.runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onOpenRun(run)}
                  data-testid={`coding-agent-history-older-${run.id}`}
                  className={`${CARD_SURFACE} w-full text-left px-3 py-2 hover:bg-black/30 transition-colors`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {chip(run.status)}
                    <span className="text-[11px] text-[var(--text-muted)]">{projectName(run.directory)}</span>
                  </div>
                  <p className="text-xs text-[var(--text-primary)] mt-1 break-words">
                    {run.reviewOf ? t("codingAgent.reviewPassTitle", { id: run.reviewOf }) : firstLine(run.task, 100)}
                  </p>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    {when(run.startedAt)} · {t("codingAgent.history.olderMeta", { turns: run.numTurns, files: run.filesTouched.length })}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {tab === "archived" && archived && (
        archived.entries.length === 0 ? (
          <p className="mt-4 px-1 text-xs text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-history-archived-empty">
            {t("codingAgent.history.archivedEmpty", { count: liveKept })}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2" data-testid="coding-agent-history-archived">
            {archived.entries.map((entry) => (
              <li key={entry.id} className={`${CARD_SURFACE} px-3 py-2 flex items-start justify-between gap-3`}>
                <button
                  type="button"
                  onClick={() => setOpenId(entry.id)}
                  data-testid={`coding-agent-history-archived-${entry.id}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {chip(entry.status)}
                    <span className="text-[11px] text-[var(--text-muted)]">{projectName(entry.project || entry.directory)}</span>
                  </div>
                  <p className="text-xs text-[var(--text-primary)] mt-1 break-words">{entry.title || entry.id}</p>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    {when(entry.startedAt)} · {bytes(entry.bytes)} · {t("codingAgent.history.archivedAt", { when: when(entry.archivedAt) })}
                  </p>
                </button>
                <a
                  href={archivedRunZipUrl(entry.id)}
                  download
                  className={BTN_SECONDARY}
                  title={t("codingAgent.history.exportRun")}
                  aria-label={`${t("codingAgent.history.exportRun")} — ${entry.title || entry.id}`}
                  data-testid={`coding-agent-history-archived-export-${entry.id}`}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">folder_zip</span>
                  <span className="hidden @md:inline">{t("codingAgent.history.exportRun")}</span>
                </a>
              </li>
            ))}
          </ul>
        )
      )}

      {tab !== null && shown < total && (
        <button type="button" onClick={() => void more()} disabled={busy} className={`${BTN_SECONDARY} w-full mt-2`} data-testid="coding-agent-history-more">
          {t("codingAgent.more")} ({total - shown})
        </button>
      )}
    </div>
  );
}
