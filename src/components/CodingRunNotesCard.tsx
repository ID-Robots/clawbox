"use client";

/**
 * A project's RUN NOTES on its page (src/lib/coding-run-notes.ts): what earlier
 * runs in this project learned — the test command, a flag the build needs, a
 * gotcha — which every run and every team role reads in its brief. Runs add
 * lessons themselves through the box's vetted channel; this is where the owner
 * reads them, corrects them, adds their own, or clears the lot.
 *
 * Folded to one line until opened: most visits to a project page are about
 * its runs, and the notes are there when the owner wants them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_SECONDARY, FIELD, INSET_SURFACE } from "./coding-agent-ui";

interface Props {
  directory: string;
  projectId: string | null;
}

interface NotesAnswer {
  notes: string;
  maxChars: number;
  file: string;
}

const FALLBACK_MAX_CHARS = 4_000;

export default function CodingRunNotesCard({ directory, projectId }: Props) {
  const { t } = useT();
  const [notes, setNotes] = useState<string | null>(null);
  const [maxChars, setMaxChars] = useState(FALLBACK_MAX_CHARS);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A read that started for another project must not paint over this one.
  const scope = useRef(0);

  const query = projectId
    ? `projectId=${encodeURIComponent(projectId)}`
    : `directory=${encodeURIComponent(directory)}`;

  const take = (data: NotesAnswer) => {
    setNotes(typeof data.notes === "string" ? data.notes : "");
    if (typeof data.maxChars === "number" && data.maxChars > 0) setMaxChars(data.maxChars);
  };

  const load = useCallback(async () => {
    const mine = ++scope.current;
    try {
      const res = await fetch(`/setup-api/coding-agent/run-notes?${query}`, { cache: "no-store" });
      if (mine !== scope.current) return;
      if (!res.ok) {
        setNotes("");
        setError(t("codingAgent.runNotes.loadFailed"));
        return;
      }
      take(await res.json() as NotesAnswer);
      setError(null);
    } catch {
      if (mine === scope.current) {
        setNotes("");
        setError(t("codingAgent.runNotes.loadFailed"));
      }
    }
  }, [query, t]);

  // The first read happens here: the card has no other moment to ask, and the
  // answer is one render. A different project is a different card (the page
  // keys it by scope), so nothing of the last one needs resetting.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { scope.current++; };
  }, [load]);

  /** The server's own sentence when it gave one (too long, looks like a secret), else ours. */
  const failure = async (res: Response, fallback: string): Promise<string> => {
    try {
      const data = await res.json() as { error?: unknown };
      return typeof data.error === "string" && data.error ? data.error : fallback;
    } catch {
      return fallback;
    }
  };

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/run-notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(projectId ? { projectId } : { directory }), notes: draft }),
      });
      if (!res.ok) {
        setError(await failure(res, t("codingAgent.runNotes.saveFailed")));
        return;
      }
      take(await res.json() as NotesAnswer);
      setDraft(null);
    } catch {
      setError(t("codingAgent.runNotes.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/setup-api/coding-agent/run-notes?${query}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await failure(res, t("codingAgent.runNotes.clearFailed")));
        return;
      }
      take(await res.json() as NotesAnswer);
      setConfirmClear(false);
      setDraft(null);
    } catch {
      setError(t("codingAgent.runNotes.clearFailed"));
    } finally {
      setBusy(false);
    }
  };

  const lessons = notes ? notes.split("\n").filter((line) => line.trim()).length : 0;

  return (
    <details className={`mt-2 ${INSET_SURFACE} px-3 py-1.5 text-[11px]`} data-testid="coding-run-notes">
      <summary className="cursor-pointer select-none flex items-center gap-2 text-[var(--text-muted)]">
        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">sticky_note_2</span>
        <span className="text-[var(--text-secondary)]">{t("codingAgent.runNotes.title")}</span>
        <span data-testid="coding-run-notes-count">
          {notes === null ? "…" : lessons > 0 ? t("codingAgent.runNotes.lines", { n: lessons }) : t("codingAgent.runNotes.none")}
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[var(--text-muted)] leading-relaxed">{t("codingAgent.runNotes.help")}</p>
        {draft === null ? (
          <>
            {notes ? (
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text-primary)]" data-testid="coding-run-notes-text">{notes}</pre>
            ) : notes !== null ? (
              <p className="text-[var(--text-muted)] italic" data-testid="coding-run-notes-empty">{t("codingAgent.runNotes.empty")}</p>
            ) : null}
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => { setDraft(notes ?? ""); setConfirmClear(false); setError(null); }} disabled={busy || notes === null} data-testid="coding-run-notes-edit" className={BTN_SECONDARY}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">edit</span>
                {t("codingAgent.runNotes.edit")}
              </button>
              {notes && !confirmClear && (
                <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} data-testid="coding-run-notes-clear" className={BTN_SECONDARY}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">delete_sweep</span>
                  {t("codingAgent.runNotes.clear")}
                </button>
              )}
              {confirmClear && (
                <span className="flex items-center gap-2" role="group" aria-label={t("codingAgent.runNotes.clearConfirm")}>
                  <span className="text-amber-300">{t("codingAgent.runNotes.clearConfirm")}</span>
                  <button type="button" onClick={() => void clear()} disabled={busy} data-testid="coding-run-notes-clear-confirm" className={BTN_SECONDARY}>
                    {t("codingAgent.runNotes.clear")}
                  </button>
                  <button type="button" onClick={() => setConfirmClear(false)} disabled={busy} data-testid="coding-run-notes-clear-cancel" className={BTN_SECONDARY}>
                    {t("cancel")}
                  </button>
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, maxChars))}
              maxLength={maxChars}
              rows={8}
              aria-label={t("codingAgent.runNotes.title")}
              placeholder={t("codingAgent.runNotes.placeholder")}
              data-testid="coding-run-notes-input"
              className={`w-full text-base sm:text-xs font-mono ${FIELD}`}
            />
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => void save()} disabled={busy} data-testid="coding-run-notes-save" className={BTN_SECONDARY}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">save</span>
                {busy ? t("codingAgent.runNotes.saving") : t("codingAgent.runNotes.save")}
              </button>
              <button type="button" onClick={() => { setDraft(null); setError(null); }} disabled={busy} data-testid="coding-run-notes-cancel" className={BTN_SECONDARY}>
                {t("cancel")}
              </button>
              <span className="ml-auto text-[var(--text-muted)]" data-testid="coding-run-notes-chars">
                {t("codingAgent.runNotes.chars", { n: draft.length, max: maxChars })}
              </span>
            </div>
          </>
        )}
        {error && <p className="text-red-300" role="alert" data-testid="coding-run-notes-error">{error}</p>}
      </div>
    </details>
  );
}
