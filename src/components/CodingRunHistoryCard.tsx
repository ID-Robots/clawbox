"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { onCodingAgentChanged } from "@/lib/ui-events";
import type { HistoryRetentionMode } from "@/lib/coding-run-history";
import { BTN_SECONDARY, CARD, FIELD } from "./coding-agent-ui";

/**
 * The Run history card on the Coding Agent's settings page (TASK-1178): what
 * the box keeps of finished runs — Standard or Keep everything — what that
 * weighs, whether the disk guard is holding the history back, and Export all
 * history. Kept lean on purpose: the mode's hint is the one sentence of
 * explanation, and the older runs themselves are on each project's Runs tab
 * ("Show older"). The archive mode, its tab, its per-run zips and its Clear
 * went in SCA2 C1 (2026-10-30).
 *
 * The SETTING is saved through the settings panel's own write chain (`onSave`,
 * POST /setup-api/coding-agent/enable) like every other setting there; the
 * figures come from GET /setup-api/coding-agent/history, read here and again
 * after every save.
 */

/** The wire shape of GET /setup-api/coding-agent/history — RunHistorySummary. */
export interface RunHistorySummaryWire {
  mode: HistoryRetentionMode;
  liveKept: number;
  counts: { live: number; older: number };
  usage: {
    runsFile: number;
    olderRuns: number;
    evidence: number;
    inputs: number;
    streams: number;
    transcripts: number;
    total: number;
    truncated: boolean;
  } | null;
  disk: { freeBytes: number | null; totalBytes: number | null; minFreeBytes: number; low: boolean };
  transcripts: { file: string; label: string; days: number | null; kept: boolean; readable: boolean }[];
}

const MODES: readonly HistoryRetentionMode[] = ["standard", "everything"];
const MODE_LABEL: Record<HistoryRetentionMode, string> = {
  standard: "codingAgent.history.modeStandard",
  everything: "codingAgent.history.modeEverything",
};
const MODE_HINT: Record<HistoryRetentionMode, string> = {
  standard: "codingAgent.history.modeStandardHint",
  everything: "codingAgent.history.modeEverythingHint",
};

export default function CodingRunHistoryCard({
  mode,
  liveKept,
  saving,
  onSave,
  error,
}: {
  mode: HistoryRetentionMode;
  liveKept: number;
  saving: boolean;
  /** Save through the panel's chain; resolves null when the write was refused. */
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
  /** The panel's refusal for this card's slot, drawn under the controls. */
  error: ReactNode;
}) {
  const { t, locale } = useT();
  const [summary, setSummary] = useState<RunHistorySummaryWire | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);

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
  // the setting the server now holds. The card's first read, like the panel's:
  // it has no other moment to ask, and each answer is one render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh, mode]);
  // And whenever the coding agent says it changed — the app's Clear history
  // (on the same page) deletes runs this card counts.
  useEffect(() => onCodingAgentChanged(() => { void refresh(); }), [refresh]);

  const bytes = (n: number | null | undefined) => formatBytes(n ?? null, locale) ?? "0 B";
  // What the NEXT run to join the list will take away under this setting —
  // under standard, every older run a "keep everything" spell left behind.
  const pending = mode === "standard" ? summary?.counts.older ?? 0 : 0;

  return (
    <div className={CARD} data-testid="coding-agent-history-card">
      <div className="flex items-center gap-2">
        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">history</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("codingAgent.history.title")}</h3>
      </div>

      {/* No paragraph under the title: the mode's own hint below says what the
          chosen setting keeps, which is all the owner opened this for. */}
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
        {t(MODE_HINT[mode], { count: liveKept })}
      </p>

      {pending > 0 && (
        <p className="text-[11px] text-amber-300 mt-2 leading-relaxed" data-testid="coding-agent-history-pending">
          {t("codingAgent.history.pendingDelete", { count: pending })}
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

      {/* One line, not an inset of two: what it weighs, the counts and the
          free space, read together. */}
      <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-history-usage">
        {summary?.usage ? (
          <>
            {t("codingAgent.history.usage", { size: bytes(summary.usage.total) })}
            {" "}
            {t("codingAgent.history.usageCounts", { live: summary.counts.live, older: summary.counts.older })}
            {summary.disk.freeBytes !== null && <> · {t("codingAgent.history.usageFree", { free: bytes(summary.disk.freeBytes) })}</>}
          </>
        ) : (
          summaryFailed || summary ? t("codingAgent.history.usageUnknown") : t("codingAgent.history.usageMeasuring")
        )}
      </p>

      {summary?.disk.low && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300 leading-relaxed" data-testid="coding-agent-history-low-disk">
          <span className="material-symbols-rounded shrink-0" style={{ fontSize: 14 }} aria-hidden="true">warning</span>
          <span>{t("codingAgent.history.lowDisk", { min: bytes(summary.disk.minFreeBytes), count: liveKept })}</span>
        </p>
      )}

      {error}

      {/* The one whole-history action: Export all history is a download. The
          owner's Clear history sits on the same settings page. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href="/setup-api/coding-agent/history/export"
          download
          className={BTN_SECONDARY}
          data-testid="coding-agent-history-export"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">download</span>
          {t("codingAgent.history.exportAll")}
        </a>
      </div>
    </div>
  );
}
