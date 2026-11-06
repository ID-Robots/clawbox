"use client";

import { useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { renderText } from "@/lib/chat-markdown";
import { copyToClipboard } from "@/lib/clipboard";
import { formatBytes } from "@/lib/format-bytes";
import PopoutWindow from "./PopoutWindow";
import { BTN_PRIMARY, BTN_SECONDARY, SECTION_LABEL } from "./coding-agent-ui";

/**
 * The files a run was GIVEN, and where they live — as the run record carries
 * them. The assistant writes what it generates into its own state folder,
 * which sits inside a credential store no run may read; the box copies what a
 * run was handed out into a folder it can. Invisible machinery until something
 * is missing — then the owner's question is "where do I put the file?", and
 * the folder named here is the answer. A record written before the hand-over
 * existed has no `inputs` at all, and the dialog says nothing about them.
 */
export interface RunInputs {
  dir: string;
  shared: string;
  files?: { name: string; bytes: number }[];
  refused?: { name: string; code: string }[];
}

/** The refusal codes the device stores, worded from the catalogue. Folded into
 *  four sentences rather than one per code: "not absolute" and "outside the
 *  folders this box copies from" are one fact to a reader — the path is not
 *  somewhere the box takes files from. */
const REFUSAL_KEYS: Record<string, string> = {
  not_absolute: "codingAgent.inputsRefusedLocation",
  outside_roots: "codingAgent.inputsRefusedLocation",
  not_a_file: "codingAgent.inputsRefusedMissing",
  too_large: "codingAgent.inputsRefusedSize",
  too_many: "codingAgent.inputsRefusedSize",
  copy_failed: "codingAgent.inputsRefusedFailed",
};

/** Whether a record has anything to say about its inputs: a file handed over, or one refused. */
export function hasRunInputs(inputs: RunInputs | null | undefined): inputs is RunInputs {
  return Boolean(inputs && typeof inputs.dir === "string" && inputs.dir && ((inputs.files?.length ?? 0) > 0 || (inputs.refused?.length ?? 0) > 0));
}

/**
 * The whole task a run was given, in a dialog of its own.
 *
 * A task is often a page: the assistant hands a run the pull request, the
 * reviewer's thread, the file list and six numbered steps. The run's page
 * showed the first line as its title and the rest under a `<details>` that
 * unfolded a 12-rem box of raw text inside the header card — the owner's
 * complaint (2026-10-12): "show the whole task needs a better preview popup
 * that we can use to easily understand the task". So the rest opens HERE:
 * a window of its own (PopoutWindow since 2026-11-01: dragged, resized,
 * snapped and maximized like any desktop window; Escape still closes it), the
 * text rendered as Markdown through the chat's renderer —
 * headings, lists, code and links become what they are, never HTML — and a
 * Copy for the owner who wants to paste it somewhere else.
 *
 * Under the task, the files the run was GIVEN (the "Inputs for this run" card
 * the page used to draw, folded in here on 2026-10-30 — the run page is one
 * column of what the run did, and what it was handed belongs with what it was
 * told): the list, the refusals worded from the catalogue, and the two folders.
 */
export default function CodingTaskDialog({ title, task, runId, inputs = null, onClose }: {
  /** The first line, as the page draws it. */
  title: string;
  /** The task as the run was given it. */
  task: string;
  runId: string;
  /** The files it was handed; nothing is drawn for a record without them. */
  inputs?: RunInputs | null;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const inputFiles = inputs?.files ?? [];
  const refused = inputs?.refused ?? [];
  const titleId = useId();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyToClipboard(task))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <PopoutWindow
      title={`${t("codingAgent.taskDialogTitle")} · ${title}`}
      appId="coding-task"
      defaultWidth={760}
      defaultHeight={600}
      onClose={onClose}
      labelledBy={titleId}
    >
        {/* A window, not a modal (2026-11-01): it moves, resizes, snaps and
            maximizes like every other one, and the desktop behind stays live.
            The window is the (non-modal) dialog, named by the run's title. */}
        <div
          data-testid="coding-agent-task-dialog"
          className="h-full flex flex-col bg-[var(--surface-1,#16171b)]"
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/[0.06]">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.taskDialogTitle")}</p>
              <h2 id={titleId} className="mt-0.5 text-sm font-semibold text-[var(--text-primary)] break-words">{title}</h2>
              <p className="mt-0.5 text-[11px] font-mono text-[var(--text-muted)]">{runId}</p>
            </div>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-[13px] text-[var(--text-secondary)] leading-relaxed break-words [&_img]:max-w-full [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--text-primary)] [&_h1]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_h2]:mt-3 [&_h3]:font-semibold [&_h3]:text-[var(--text-primary)] [&_h3]:mt-2 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-2 [&_pre]:my-2 [&_code]:font-mono [&_code]:text-[12px] [&_a]:underline [&_a]:decoration-white/30"
            data-testid="coding-agent-task-dialog-body"
          >
            {renderText(task, t("chat.table"))}
            {hasRunInputs(inputs) && (
              <div className="mt-4 pt-3 border-t border-white/[0.06]" data-testid="coding-agent-inputs">
                <p className={SECTION_LABEL}>
                  {t("codingAgent.inputsTitle")}
                  {inputFiles.length > 0 && (
                    <span className="normal-case tracking-normal font-normal text-[var(--text-muted)]">({inputFiles.length})</span>
                  )}
                </p>
                {inputFiles.length > 0 ? (
                  <ul className="mt-1.5 space-y-1" data-testid="coding-agent-inputs-files">
                    {inputFiles.map((f) => (
                      <li key={f.name} className="flex items-baseline gap-2">
                        <span className="text-[11px] font-mono text-[var(--text-secondary)] break-all">{f.name}</span>
                        <span className="text-[11px] text-[var(--text-muted)]">{formatBytes(f.bytes, locale)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-inputs-empty">
                    {t("codingAgent.inputsEmpty")}
                  </p>
                )}
                {refused.length > 0 && (
                  <div className="mt-2" data-testid="coding-agent-inputs-refused">
                    <p className="text-[11px] font-medium text-amber-400">{t("codingAgent.inputsRefusedTitle")}</p>
                    <ul className="mt-1 space-y-1">
                      {refused.map((r, i) => (
                        <li key={`${r.name}-${i}`} className="text-[11px] text-[var(--text-muted)] break-all">
                          <span className="font-mono text-[var(--text-secondary)]">{r.name}</span>
                          {/* A code this build does not know says nothing rather
                              than printing the code itself: the owner reads
                              sentences, and a bare `outside_roots` is not one. */}
                          {REFUSAL_KEYS[r.code] && <span> — {t(REFUSAL_KEYS[r.code])}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-[var(--text-muted)] opacity-70 leading-relaxed break-all">
                  {t("codingAgent.inputsHint", { folder: inputs.dir, shared: inputs.shared })}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            <button type="button" onClick={() => void copy()} data-testid="coding-agent-task-dialog-copy" className={BTN_SECONDARY}>
              {copied ? t("codingAgent.copied") : t("codingAgent.taskDialogCopy")}
            </button>
            <button type="button" onClick={onClose} data-testid="coding-agent-task-dialog-close" className={BTN_PRIMARY}>
              {t("codingAgent.taskDialogClose")}
            </button>
          </div>
        </div>
    </PopoutWindow>
  );
}
