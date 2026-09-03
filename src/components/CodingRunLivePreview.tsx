"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import TerminalApp from "./TerminalApp";

/**
 * The floating live view of a coding run: a small terminal that tails the
 * run's transcript (or resumes its session once it has finished), popped over
 * the desktop from the chat's run card. One click on its bar folds it down to
 * the bar alone and another unfolds it — "a quick preview window that we can
 * hide by clicking" — and the X closes it. The terminal stays mounted while
 * folded, so the tail keeps up and unfolding shows where the run is now, not
 * where it was.
 *
 * The desktop owns exactly one of these (page.tsx); a second request for the
 * same run raises it, a request for another run replaces it. The "Open in
 * Terminal" button hands the same command to a full Terminal window, for an
 * owner who wants to keep it around.
 */

/** Where the preview script lives on the device — the Coding Agent app's constant. */
const CLAWBOX_ROOT = "/home/clawbox/clawbox";

/** Single-quote a value for the terminal command line. */
function quoted(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * The command the terminal types: a readable live tail while the run works,
 * `claude-ds --resume` once there is only a session left. Null when neither
 * exists yet — a run in its first seconds has no transcript to show.
 */
export function livePreviewCommand(run: {
  transcriptPath: string | null;
  sessionId: string | null;
  directory: string | null;
  live: boolean;
}): string | null {
  if (run.live && run.transcriptPath) {
    return `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
  }
  if (run.sessionId && run.directory) {
    return `cd ${quoted(run.directory)} && claude-ds --resume ${run.sessionId}`;
  }
  if (run.transcriptPath) {
    return `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
  }
  return null;
}

export default function CodingRunLivePreview({
  runId,
  command,
  onClose,
}: {
  runId: string;
  /** From livePreviewCommand(); null draws the bar with a "not yet" line. */
  command: string | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [folded, setFolded] = useState(false);

  const openInTerminal = () => {
    if (!command) return;
    window.dispatchEvent(new CustomEvent("clawbox:open-terminal", { detail: { command } }));
    onClose();
  };

  return (
    <div
      data-testid="coding-live-preview"
      data-folded={folded ? "true" : undefined}
      className="fixed left-4 z-[99998] w-[560px] max-w-[calc(100vw-2rem)] rounded-xl overflow-hidden border border-white/10 bg-[var(--bg-elevated)] shadow-2xl animate-in slide-in-from-bottom-2 fade-in duration-200"
      style={{ bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 16px)" }}
    >
      {/* The bar: the whole width folds and unfolds the preview, so the
          owner can tuck it away with one click and bring it back the same way.
          The two controls stop the click from reaching it. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!folded}
        aria-label={folded ? t("codingAgent.livePreviewShow") : t("codingAgent.livePreviewHide")}
        onClick={() => setFolded((f) => !f)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFolded((f) => !f); }
        }}
        data-testid="coding-live-preview-bar"
        className="flex items-center gap-2 h-9 px-3 cursor-pointer select-none bg-[#1f2228] border-b border-white/[0.06] hover:bg-[#262a33]"
      >
        <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 16 }} aria-hidden="true">terminal</span>
        <span className="text-xs font-semibold text-white">{t("codingAgent.livePreviewTitle")}</span>
        <span className="text-[11px] font-mono text-white/40 truncate">{runId}</span>
        <span className="ml-auto flex items-center gap-1">
          {command && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openInTerminal(); }}
              title={t("codingAgent.livePreviewOpenApp")}
              aria-label={t("codingAgent.livePreviewOpenApp")}
              data-testid="coding-live-preview-open"
              className="w-7 h-7 flex items-center justify-center rounded-md text-white/50 hover:text-white hover:bg-white/10 bg-transparent border-none cursor-pointer"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">open_in_new</span>
            </button>
          )}
          <span className="material-symbols-rounded text-white/50" style={{ fontSize: 18 }} aria-hidden="true">
            {folded ? "expand_less" : "expand_more"}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            aria-label={t("codingAgent.livePreviewClose")}
            data-testid="coding-live-preview-close"
            className="w-7 h-7 flex items-center justify-center rounded-md text-white/50 hover:text-white hover:bg-white/10 bg-transparent border-none cursor-pointer"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">close</span>
          </button>
        </span>
      </div>
      {/* Folded: zero height, still mounted, so the tail keeps up. */}
      <div className={folded ? "h-0 overflow-hidden" : "h-[320px]"} data-testid="coding-live-preview-body">
        {command ? (
          <TerminalApp initialCommand={command} />
        ) : (
          <p className="p-4 text-xs text-[var(--text-muted)]">{t("codingAgent.livePreviewNotYet")}</p>
        )}
      </div>
    </div>
  );
}
