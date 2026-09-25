"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { onCodingAgentChanged } from "@/lib/ui-events";
import type { HistoryRetentionMode } from "@/lib/coding-run-history";
import HelpTip from "./HelpTip";
import StatusMessage from "./StatusMessage";
import { BTN_DANGER, BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";

/**
 * The Run history card on the Coding Agent's settings page (TASK-1178): what
 * the box keeps of finished runs, what that weighs, whether the disk guard is
 * holding the history back, and the two whole-history actions — Export all and
 * Clear archive.
 *
 * The SETTING is saved through the settings panel's own write chain (`onSave`,
 * POST /setup-api/coding-agent/enable) like every other setting there; the
 * figures come from GET /setup-api/coding-agent/history, read here and again
 * after every save and every clear.
 */

/** The wire shape of GET /setup-api/coding-agent/history — RunHistorySummary. */
export interface RunHistorySummaryWire {
  mode: HistoryRetentionMode;
  limit: number;
  limits: number[];
  liveKept: number;
  counts: { live: number; older: number; archived: number };
  usage: {
    runsFile: number;
    olderRuns: number;
    evidence: number;
    inputs: number;
    streams: number;
    archive: number;
    transcripts: number;
    total: number;
    truncated: boolean;
  } | null;
  disk: { freeBytes: number | null; totalBytes: number | null; minFreeBytes: number; low: boolean };
  transcripts: { file: string; label: string; days: number | null; kept: boolean; readable: boolean }[];
}

const MODES: readonly HistoryRetentionMode[] = ["standard", "extended", "everything", "archive"];
const MODE_LABEL: Record<HistoryRetentionMode, string> = {
  standard: "codingAgent.history.modeStandard",
  extended: "codingAgent.history.modeExtended",
  everything: "codingAgent.history.modeEverything",
  archive: "codingAgent.history.modeArchive",
};
const MODE_HINT: Record<HistoryRetentionMode, string> = {
  standard: "codingAgent.history.modeStandardHint",
  extended: "codingAgent.history.modeExtendedHint",
  everything: "codingAgent.history.modeEverythingHint",
  archive: "codingAgent.history.modeArchiveHint",
};

/** How long the two-tap Clear archive stays armed — the app's CONFIRM_MS. */
const CONFIRM_MS = 5_000;

/**
 * How many older runs the NEXT run to join the list will take away under this
 * setting — the figure the card warns with, computed the way insertRun trims.
 */
export function olderRunsOverLimit(mode: HistoryRetentionMode, limit: number, counts: RunHistorySummaryWire["counts"]): number {
  if (mode === "everything") return 0;
  if (mode === "extended") return Math.max(0, counts.older - Math.max(0, limit - counts.live));
  return counts.older;
}

export default function CodingRunHistoryCard({
  mode,
  limit,
  limits,
  liveKept,
  saving,
  onSave,
  error,
  onOpenHistory,
}: {
  mode: HistoryRetentionMode;
  limit: number;
  limits: number[];
  liveKept: number;
  saving: boolean;
  /** Save through the panel's chain; resolves null when the write was refused. */
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
  /** The panel's refusal for this card's slot, drawn under the controls. */
  error: ReactNode;
  /** Open the Run history page. Absent where there is no page to open. */
  onOpenHistory?: () => void;
}) {
  const { t, locale } = useT();
  const [summary, setSummary] = useState<RunHistorySummaryWire | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearNote, setClearNote] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirmClear(false);
  };
  const arm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => {
      confirmTimer.current = null;
      setConfirmClear(false);
    }, CONFIRM_MS);
    setConfirmClear(true);
  };
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/coding-agent/history", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSummary(await res.json() as RunHistorySummaryWire);
      setSummaryFailed(false);
    } catch {
      setSummaryFailed(true);
    }
  }, []);

  // Again after every save: the transcript period and the warning both follow
  // the setting the server now holds.
  useEffect(() => { void refresh(); }, [refresh, mode, limit]);
  // And whenever the coding agent says it changed — the app's Clear history
  // (on the same page) deletes or archives runs this card counts.
  useEffect(() => onCodingAgentChanged(() => { void refresh(); }), [refresh]);

  const clearArchive = async () => {
    setClearing(true);
    setClearNote(null);
    try {
      const res = await fetch("/setup-api/coding-agent/history?view=archive", { method: "DELETE" });
      const body = await res.json().catch(() => ({})) as { cleared?: number; error?: string };
      if (!res.ok) throw new Error(body.error || t("codingAgent.history.clearArchiveFailed"));
      setClearNote({ type: "success", message: t("codingAgent.history.clearArchiveDone", { count: body.cleared ?? 0 }) });
    } catch (err) {
      setClearNote({ type: "error", message: err instanceof Error ? err.message : t("codingAgent.history.clearArchiveFailed") });
    } finally {
      setClearing(false);
      void refresh();
    }
  };

  const bytes = (n: number | null | undefined) => formatBytes(n ?? null, locale) ?? "0 B";
  const pending = summary ? olderRunsOverLimit(mode, limit, summary.counts) : 0;
  const archived = summary?.counts.archived ?? 0;

  return (
    <div className={CARD} data-testid="coding-agent-history-card">
      <div className="flex items-center gap-2">
        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">history</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("codingAgent.history.title")}</h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">{t("codingAgent.history.hint")}</p>

      <div className="flex items-start justify-between gap-4 mt-4">
        <label htmlFor="coding-agent-history-mode" className="text-xs font-medium text-[var(--text-secondary)]">
          {t("codingAgent.history.modeLabel")}
        </label>
        <select
          id="coding-agent-history-mode"
          value={mode}
          disabled={saving}
          data-testid="coding-agent-history-mode"
          onChange={(e) => void onSave({ historyRetention: e.target.value })}
          className={`text-base sm:text-xs ${FIELD} w-44`}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>{t(MODE_LABEL[m])}</option>
          ))}
        </select>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed" data-testid="coding-agent-history-mode-hint">
        {t(MODE_HINT[mode], { count: liveKept, limit })}
      </p>

      {mode === "extended" && (
        <div className="flex items-start justify-between gap-4 mt-3">
          <label htmlFor="coding-agent-history-limit" className="text-xs font-medium text-[var(--text-secondary)]">
            {t("codingAgent.history.limitLabel")}
          </label>
          <select
            id="coding-agent-history-limit"
            value={String(limit)}
            disabled={saving}
            data-testid="coding-agent-history-limit"
            onChange={(e) => void onSave({ historyLimit: Number(e.target.value) })}
            className={`text-base sm:text-xs ${FIELD} w-44`}
          >
            {limits.map((n) => (
              <option key={n} value={n}>{t("codingAgent.history.limitOption", { count: n })}</option>
            ))}
          </select>
        </div>
      )}

      {pending > 0 && (
        <p className="text-[11px] text-amber-300 mt-2 leading-relaxed" data-testid="coding-agent-history-pending">
          {mode === "archive"
            ? t("codingAgent.history.pendingArchive", { count: pending })
            : t("codingAgent.history.pendingDelete", { count: pending })}
        </p>
      )}

      {mode === "archive" && (
        <p className="text-[11px] text-[var(--text-muted)] mt-2 leading-relaxed" data-testid="coding-agent-history-archive-note">
          {t("codingAgent.history.archiveTranscriptNote")}
        </p>
      )}

      {mode === "everything" && summary && summary.transcripts.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="coding-agent-history-transcripts">
          {summary.transcripts.map((f) => (
            <li key={f.file} className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${f.kept ? "text-emerald-300" : "text-amber-300"}`}>
              <span className="material-symbols-rounded shrink-0" style={{ fontSize: 14 }} aria-hidden="true">{f.kept ? "check_circle" : "warning"}</span>
              <span className="break-all">
                {f.kept
                  ? t("codingAgent.history.transcriptsKept", { file: f.label })
                  : f.readable
                    ? t("codingAgent.history.transcriptsNotKept", { file: f.label })
                    : t("codingAgent.history.transcriptsUnreadable", { file: f.label })}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-lg bg-black/25 border border-white/[0.06] px-3 py-2" data-testid="coding-agent-history-usage">
        {summary?.usage ? (
          <>
            <p className="text-xs text-[var(--text-primary)]">
              {t("codingAgent.history.usage", { size: bytes(summary.usage.total) })}
            </p>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {t("codingAgent.history.usageCounts", { live: summary.counts.live, older: summary.counts.older, archived: summary.counts.archived })}
              {summary.disk.freeBytes !== null && <> · {t("codingAgent.history.usageFree", { free: bytes(summary.disk.freeBytes) })}</>}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">
            {summaryFailed || summary ? t("codingAgent.history.usageUnknown") : t("codingAgent.history.usageMeasuring")}
          </p>
        )}
      </div>

      {summary?.disk.low && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300 leading-relaxed" data-testid="coding-agent-history-low-disk">
          <span className="material-symbols-rounded shrink-0" style={{ fontSize: 14 }} aria-hidden="true">warning</span>
          <span>{t("codingAgent.history.lowDisk", { min: bytes(summary.disk.minFreeBytes), count: liveKept })}</span>
        </p>
      )}

      {error}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {onOpenHistory && (
          <button type="button" onClick={onOpenHistory} className={BTN_SECONDARY} data-testid="coding-agent-history-open">
            <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">manage_history</span>
            {t("codingAgent.history.open")}
          </button>
        )}
        <span className="inline-flex items-center gap-1">
          <a
            href="/setup-api/coding-agent/history/export"
            download
            className={BTN_SECONDARY}
            data-testid="coding-agent-history-export"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">download</span>
            {t("codingAgent.history.exportAll")}
          </a>
          <HelpTip text={t("codingAgent.history.exportAllHint")} label={t("codingAgent.history.exportAll")} testId="coding-agent-history-export-help" />
        </span>
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => { if (confirmClear) { disarm(); void clearArchive(); } else arm(); }}
            onBlur={disarm}
            disabled={clearing || archived === 0}
            className={confirmClear ? BTN_DANGER : BTN_SECONDARY}
            data-testid="coding-agent-history-clear-archive"
          >
            {confirmClear ? t("codingAgent.history.clearArchiveConfirm", { count: archived }) : t("codingAgent.history.clearArchive")}
          </button>
          <HelpTip text={t("codingAgent.history.clearArchiveHint")} label={t("codingAgent.history.clearArchive")} testId="coding-agent-history-clear-help" />
        </span>
      </div>
      {clearNote && (
        <div className="mt-2" data-testid="coding-agent-history-clear-note">
          <StatusMessage type={clearNote.type} message={clearNote.message} />
        </div>
      )}
    </div>
  );
}
