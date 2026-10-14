"use client";

import { useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { copyToClipboard } from "@/lib/clipboard";
import { useModalDialog } from "@/hooks/useModalDialog";
import { ClawKeepModalPortal } from "./clawkeep-ui";
import { BTN_PRIMARY, BTN_SECONDARY } from "./coding-agent-ui";

/**
 * The whole task a run was given, in a dialog of its own.
 *
 * A task is often a page: the assistant hands a run the pull request, the
 * reviewer's thread, the file list and six numbered steps. The run's page
 * showed the first line as its title and the rest under a `<details>` that
 * unfolded a 12-rem box of raw text inside the header card — the owner's
 * complaint (2026-10-12): "show the whole task needs a better preview popup
 * that we can use to easily understand the task". So the rest opens HERE:
 * the desktop's one modal behaviour (focus trapped, Escape closes, the page
 * behind inert), the text rendered as Markdown through the chat's renderer —
 * headings, lists, code and links become what they are, never HTML — and a
 * Copy for the owner who wants to paste it somewhere else.
 */
export default function CodingTaskDialog({ title, task, runId, onClose }: {
  /** The first line, as the page draws it. */
  title: string;
  /** The task as the run was given it. */
  task: string;
  runId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose });
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyToClipboard(task))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <ClawKeepModalPortal>
      <div
        className="main-screen-scrim fixed inset-0 z-[200] flex items-center justify-center p-4"
        // No backdrop blur under the dim: a full-screen blur is redone over the
        // whole desktop on every frame anything beneath it moves.
        style={{ background: "rgba(0, 0, 0, 0.67)" }}
        onClick={onClose}
        data-testid="coding-agent-task-dialog"
      >
        {/* The role sits on the PANEL, where the trap is attached: on the
            backdrop the accessible dialog would be the whole viewport. */}
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl max-h-[85%] flex flex-col rounded-2xl border border-white/[0.08] bg-[var(--surface-1,#16171b)] shadow-2xl overflow-hidden"
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/[0.06]">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.taskDialogTitle")}</p>
              <h2 id={titleId} className="mt-0.5 text-sm font-semibold text-[var(--text-primary)] break-words">{title}</h2>
              <p className="mt-0.5 text-[11px] font-mono text-[var(--text-muted)]">{runId}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("codingAgent.taskDialogClose")}
              data-testid="coding-agent-task-dialog-close"
              className="shrink-0 rounded-md p-1 text-[var(--text-muted)] hover:text-white hover:bg-white/[0.06]"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
            </button>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-[13px] text-[var(--text-secondary)] leading-relaxed break-words [&_img]:max-w-full [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--text-primary)] [&_h1]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_h2]:mt-3 [&_h3]:font-semibold [&_h3]:text-[var(--text-primary)] [&_h3]:mt-2 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_pre]:my-2 [&_code]:font-mono [&_code]:text-[12px] [&_a]:underline [&_a]:decoration-white/30"
            data-testid="coding-agent-task-dialog-body"
          >
            {renderText(task, t("chat.table"))}
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <button type="button" onClick={() => void copy()} data-testid="coding-agent-task-dialog-copy" className={BTN_SECONDARY}>
              {copied ? t("codingAgent.copied") : t("codingAgent.taskDialogCopy")}
            </button>
            <button type="button" onClick={onClose} className={BTN_PRIMARY}>
              {t("codingAgent.taskDialogClose")}
            </button>
          </div>
        </div>
      </div>
    </ClawKeepModalPortal>
  );
}
