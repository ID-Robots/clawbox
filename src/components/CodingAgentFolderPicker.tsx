"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { ClawKeepModalPortal } from "./clawkeep-ui";
import { BTN_PRIMARY, BTN_SECONDARY } from "./coding-agent-ui";

export type BrowseAnswer = {
  root: string;
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated?: boolean;
};

/**
 * The Coding Agent's folder picker, as a sheet.
 *
 * ONE picker for the two places the owner chooses the project folder — the
 * Settings face's folder row and the wizard's project step — over the same
 * route both already used (`/setup-api/coding-agent/browse`, directories
 * only, rooted at the owner's home by `filesBrowseRoot()`). Until the
 * 2026-10-30 redesign each place also had a typed path field and the wizard
 * a "Create folder" name field: typing a path is not a thing an owner does on
 * a phone, and a folder that is not there yet is created when the choice is
 * saved (the enable route makes it inside the owner's home), so the picker
 * lists EXISTING folders and nothing else — no field of any kind.
 *
 * It is the desktop's modal (useModalDialog: focus trapped, Escape closes,
 * the page behind inert) drawn as a bottom sheet on a phone and a centred
 * panel from `sm:` — viewport variants here, not the app's `@md` container
 * ones, because the portal puts this on `document.body`, outside the app's
 * `@container`. Every row is 44 px tall on a phone.
 *
 * The listing opens at `initialDir`; a folder that does not exist yet (the
 * wizard's proposed ~/Projects before anything saved it) answers 404, and the
 * picker falls back to the root rather than showing an error for a folder the
 * box itself proposed.
 */
export default function CodingAgentFolderPicker({ initialDir, onPick, onClose, testId }: {
  /** Where the listing opens; null or a folder that is not there opens at the root. */
  initialDir: string | null;
  /** The owner's choice — the ABSOLUTE path of the folder on screen. */
  onPick: (path: string) => void;
  onClose: () => void;
  /** The sheet's id; its rows and buttons hang `-up`, `-entry`, `-use`, `-close` off it. */
  testId: string;
}) {
  const { t } = useT();
  const titleId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose });
  const [browse, setBrowse] = useState<BrowseAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const open = useCallback(async (dir: string | null) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      let res = await fetch(`/setup-api/coding-agent/browse${qs}`, { signal: ctl.signal });
      if (res.status === 404 && dir) res = await fetch("/setup-api/coding-agent/browse", { signal: ctl.signal });
      if (!res.ok) throw new Error(t("codingAgent.wizardBrowseFailed"));
      setBrowse((await res.json()) as BrowseAnswer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : t("codingAgent.wizardBrowseFailed"));
    }
  }, [t]);

  // The first listing, once; the owner walks from there. `initialDir` is read
  // on open only — a parent that re-renders with a new value while the sheet
  // is up must not yank the listing out from under the owner.
  const initial = useRef(initialDir);
  useEffect(() => {
    void open(initial.current);
    return () => abort.current?.abort();
  }, [open]);

  const ROW = "w-full min-h-[44px] sm:min-h-[36px] text-left px-3 py-2 rounded-lg text-sm sm:text-xs hover:bg-white/5 cursor-pointer flex items-center gap-2";

  return (
    <ClawKeepModalPortal>
      <div
        className="main-screen-scrim fixed inset-0 z-[200] flex items-end sm:items-center justify-center sm:p-4"
        // No backdrop blur under the dim — the task dialog says why.
        style={{ background: "rgba(0, 0, 0, 0.67)" }}
        onClick={onClose}
        data-testid={testId}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          className="w-full sm:max-w-md max-h-[85dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-white/[0.08] bg-[var(--surface-1,#16171b)] shadow-2xl overflow-hidden"
        >
          <div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-white/[0.06]">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.folderLabel")}</h2>
              {/* The folder on screen — what "Use this folder" chooses. */}
              <p className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)] break-all" data-testid={`${testId}-path`}>
                {browse?.path ?? "…"}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("codingAgent.wizardPickerClose")}
              data-testid={`${testId}-close`}
              className="shrink-0 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 rounded-md p-1 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-white/[0.06]"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
            </button>
          </div>

          <ul className="flex-1 min-h-0 overflow-y-auto px-2 py-2" data-testid={`${testId}-list`}>
            {browse?.parent && (
              <li>
                <button type="button" onClick={() => void open(browse.parent)} data-testid={`${testId}-up`} className={`${ROW} text-[var(--text-secondary)]`}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">arrow_upward</span>
                  {t("codingAgent.wizardPickerUp")}
                </button>
              </li>
            )}
            {browse?.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => void open(entry.path)} data-testid={`${testId}-entry`} className={`${ROW} text-[var(--text-primary)]`}>
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">folder</span>
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
            {browse && browse.entries.length === 0 && (
              <li className="px-3 py-2 text-xs text-[var(--text-muted)]">{t("codingAgent.wizardPickerEmpty")}</li>
            )}
            {error && (
              <li className="px-3 py-2 text-xs text-red-300" role="alert">{error}</li>
            )}
          </ul>

          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/[0.06]">
            <button type="button" onClick={onClose} className={BTN_SECONDARY}>
              {t("codingAgent.wizardPickerClose")}
            </button>
            <button
              type="button"
              onClick={() => { if (browse) onPick(browse.path); }}
              disabled={!browse}
              data-testid={`${testId}-use`}
              className={BTN_PRIMARY}
            >
              {t("codingAgent.wizardPickerUse")}
            </button>
          </div>
        </div>
      </div>
    </ClawKeepModalPortal>
  );
}
