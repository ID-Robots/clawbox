"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { formatBytes } from "@/lib/format-bytes";
import { BTN_DANGER, BTN_SECONDARY, INSET_SURFACE } from "./coding-agent-ui";

/**
 * "Remove this project" — the dialog in front of the one Coding Agent action
 * that takes the owner's own code away.
 *
 * WHAT IT IS FOR. Not to ask "are you sure": a yes/no over a folder full of
 * work is a question nobody can answer. It STATES what is there — how big the
 * folder is, what git would say is unsaved, which secrets and which deploy link
 * are filed against it, how many runs worked in it — and only then asks for the
 * folder's name to be typed. The box's own preview is where every one of those
 * facts comes from (`GET …/projects/delete`), so the dialog can never promise
 * something the route would then refuse.
 *
 * THE FORCE BUTTON APPEARS LAST, and only after the box has listed exactly what
 * would be lost. That ordering is the whole design of it: a checkbox that said
 * "remove anyway" before the list would be a checkbox for skipping the reading.
 *
 * THE OTHER REFUSALS OFFER NOTHING. A live run, a folder that is not a project,
 * a path that leads out of the project roots, ClawBox's own checkout — each is
 * shown in the box's own words with no control beside it, because there is no
 * flag that makes any of them untrue.
 *
 * AFTERWARDS it says WHERE THE FOLDER WENT. The removal is a move into a
 * `.deleted-projects/` folder in the project's own root, and the path is the
 * whole point: it is what makes the red button honest.
 */

/** The shape the preview route answers with. */
export interface ProjectDeletePreview {
  folder: string;
  kind: "folder" | "codeProject";
  directory: string;
  size: { bytes: number; files: number; truncated: boolean };
  unsaved: {
    dirty: string[];
    dirtyCount: number;
    dirtyTruncated: boolean;
    unpushed: number | null;
    stashes: number;
    ignored: string[];
    ignoredCount: number;
    ignoredTruncated: boolean;
    worktrees: string[];
    notARepository: boolean;
    any: boolean;
  };
  liveRuns: { id: string; task: string }[];
  secretNames: string[];
  runCount: number;
  retentionDays: number;
  /** The count bound on the trash — the other half of the retention rule. */
  retentionMax: number;
  trashCount: number;
  /** What this removal would delete for good, straight away, to make room. */
  wouldPurge: string[];
  refusal: { code: string; message: string } | null;
}

/** The shape the DELETE answers with, once it has gone. */
export interface ProjectDeleteOutcome {
  folder: string;
  trashPath: string;
  retentionDays: number;
  retentionMax: number;
  secretsRemoved: string[];
  /** Another project of the same name still uses the secrets, so they stayed. */
  metadataKeptFor: string | null;
  /** Older removals the count bound took early to make room for this one. */
  prunedEarly: string[];
  runsKept: number;
}

export interface CodingProjectDeleteDialogProps {
  folder: string;
  kind: "folder" | "codeProject";
  /** The name the list shows, which for a code project is not the folder. */
  name: string;
  onClose: () => void;
  /** Called once the folder is gone, with the box's own answer. */
  onDeleted: (outcome: ProjectDeleteOutcome) => void;
}

export default function CodingProjectDeleteDialog({
  folder, kind, name, onClose, onDeleted,
}: CodingProjectDeleteDialogProps) {
  const { t, locale } = useT();
  const titleId = useId();
  const describedId = useId();
  const nameFieldId = useId();

  const [preview, setPreview] = useState<ProjectDeletePreview | null>(null);
  /** A refusal the PREVIEW itself met — the folder is not one this box may remove. */
  const [blocked, setBlocked] = useState<{ code: string; message: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [force, setForce] = useState(false);
  /** The owner's explicit yes to deleting somebody else's recoverable project. */
  const [purgeOldest, setPurgeOldest] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A refusal the removal met, which is not always the one the preview showed. */
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [done, setDone] = useState<ProjectDeleteOutcome | null>(null);

  const panelRef = useModalDialog<HTMLDivElement>({ onClose });

  /**
   * A refusal in the owner's language, falling back to the box's own sentence.
   *
   * Both halves matter. The code is what every locale has copy for, which is
   * the point of answering one; the box's English sentence is what an older
   * page — and a refusal this build has no key for — still shows rather than a
   * bare code. `t` answers the KEY itself when there is no entry, which is what
   * the comparison below detects.
   *
   * The route's codes are `snake_case` (they are the library's own type) and
   * translation keys in this project are camelCase — pinned by
   * translations.test.ts — so the one is spelled into the other here rather
   * than a second set of names being maintained on the server.
   */
  const refusalText = useCallback((code: string, fallback: string): string => {
    const key = `codingAgent.delete.refusal.${code.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}`;
    const said = t(key);
    return said === key ? fallback : said;
  }, [t]);

  /**
   * Read the preview. Its own function because it is needed TWICE: once when
   * the dialog opens, and again after a `trash_full` refusal — see `remove`.
   *
   * `alive` is the effect's cancellation, passed in rather than captured, so
   * the refresh below can call this with nothing to cancel.
   */
  const loadPreview = useCallback(async (alive: () => boolean = () => true) => {
    const params = new URLSearchParams({ folder, kind });
    try {
      const res = await fetch(`/setup-api/coding-agent/projects/delete?${params}`, { cache: "no-store" });
      const body = await res.json().catch(() => null) as (ProjectDeletePreview & { error?: string; code?: string }) | null;
      if (!alive()) return;
      if (!res.ok || !body) {
        setBlocked({ code: body?.code ?? "failed", message: body?.error ?? t("codingAgent.delete.previewFailed") });
        return;
      }
      setPreview(body);
    } catch {
      if (alive()) setBlocked({ code: "failed", message: t("codingAgent.delete.previewFailed") });
    }
  }, [folder, kind, t]);

  useEffect(() => {
    let live = true;
    void loadPreview(() => live);
    return () => { live = false; };
  }, [loadPreview]);

  const remove = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch("/setup-api/coding-agent/projects/delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        // `typed`, NOT `typed.trim()`: the route compares the confirmation to
        // the folder's own name byte for byte, and a folder name may legally
        // end in a space. Trimming here would make such a folder impossible to
        // confirm, and — before the route stopped trimming its own side — was
        // half of how "shop " could have removed "shop".
        body: JSON.stringify({ folder, kind, confirm: typed, force, purgeOldest }),
      });
      const body = await res.json().catch(() => null) as (ProjectDeleteOutcome & { error?: string; code?: string }) | null;
      if (!res.ok || !body) {
        setFailure({ code: body?.code ?? "failed", message: body?.error ?? t("codingAgent.delete.failed") });
        // `trash_full` is the ONE refusal the owner can clear from inside this
        // dialog, and only if the dialog can show them what they would be
        // agreeing to. It fires when the shelf filled up since the preview was
        // read — so that preview is stale by definition, and with an empty
        // `wouldPurge` the consent checkbox is not even rendered: the owner
        // would be left pressing an enabled button that posts the same refused
        // state for ever. Re-read it, and drop any consent they had given,
        // because it was consent to a DIFFERENT list of folders.
        if (body?.code === "trash_full") {
          setPurgeOldest(false);
          await loadPreview();
        }
        return;
      }
      setDone(body);
      onDeleted(body);
    } catch {
      setFailure({ code: "failed", message: t("codingAgent.delete.failed") });
    } finally {
      setBusy(false);
    }
  }, [folder, kind, typed, force, purgeOldest, onDeleted, t, loadPreview]);

  const unsaved = preview?.unsaved;
  // The ONE refusal a flag can clear. Everything else the preview reports keeps
  // the button off entirely.
  const unsavedOnly = preview?.refusal?.code === "unsaved_work";
  const hardRefusal = blocked ?? (preview?.refusal && !unsavedOnly ? preview.refusal : null);
  // Exact, for the reason the body below is not trimmed either: this gate and
  // the route's own comparison have to be the same question.
  const nameMatches = typed === folder;
  // Both flags are conditions, not preferences: each is demanded only when the
  // box has something to lose by it, and each is offered only beside the list of
  // what that is.
  const needsPurgeConsent = (preview?.wouldPurge.length ?? 0) > 0;
  const canRemove = !!preview && !hardRefusal && nameMatches
    && (!unsavedOnly || force) && (!needsPurgeConsent || purgeOldest) && !busy;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.62)", backdropFilter: "blur(6px)" }}
      data-testid="coding-agent-delete-dialog"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedId}
        className="w-full max-w-[520px] max-h-[85vh] overflow-y-auto rounded-2xl border border-white/[0.08] bg-[var(--surface-1,#16171b)] p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
          {t("codingAgent.delete.title", { name })}
        </h2>

        {done ? (
          // WHERE IT WENT. The path is the message: it is what turns "deleted"
          // back into something the owner can undo with one `mv`.
          <div className="mt-3" data-testid="coding-agent-delete-done">
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
              {t("codingAgent.delete.movedTo", { folder: done.folder })}
            </p>
            <code className="mt-2 block break-all rounded-lg bg-black/30 px-3 py-2 text-[11px] text-[var(--text-primary)]" data-testid="coding-agent-delete-trash-path">
              {done.trashPath}
            </code>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              {t("codingAgent.delete.retention", { days: done.retentionDays, max: done.retentionMax })}
            </p>
            {done.prunedEarly.length > 0 && (
              // What this removal cost somebody else. Reported rather than left
              // to be discovered: these folders were inside the thirty days the
              // owner was promised for them.
              <p
                className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100"
                data-testid="coding-agent-delete-purged"
              >
                {t("codingAgent.delete.purged", { names: done.prunedEarly.join(", ") })}
              </p>
            )}
            {(done.secretsRemoved.length > 0 || done.runsKept > 0 || done.metadataKeptFor) && (
              <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-muted)]">
                {done.secretsRemoved.length > 0 && (
                  <li>{t("codingAgent.delete.secretsRemoved", { names: done.secretsRemoved.join(", ") })}</li>
                )}
                {done.runsKept > 0 && <li>{t("codingAgent.delete.runsKept", { n: done.runsKept })}</li>}
                {/* The credentials stayed because another project answers to
                    the same name. Said plainly, or "no secrets went" would read
                    as "there were none". */}
                {done.metadataKeptFor && (
                  <li data-testid="coding-agent-delete-metadata-kept">
                    {t("codingAgent.delete.metadataKeptSecrets")}
                  </li>
                )}
              </ul>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={onClose} className={BTN_SECONDARY} data-testid="coding-agent-delete-close">
                {t("codingAgent.delete.close")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p id={describedId} className="mt-1 text-[11px] text-[var(--text-muted)] break-all">
              {preview?.directory ?? folder}
            </p>

            {!preview && !blocked && (
              <p className="mt-4 text-xs text-[var(--text-muted)]" data-testid="coding-agent-delete-loading">
                {t("codingAgent.delete.loading")}
              </p>
            )}

            {hardRefusal && (
              // No control beside it, deliberately: there is no flag that makes
              // a live run, a protected checkout or a path outside the project
              // roots into something this box will remove.
              <p
                className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200"
                data-testid="coding-agent-delete-refusal"
                data-refusal={hardRefusal.code}
              >
                {refusalText(hardRefusal.code, hardRefusal.message)}
              </p>
            )}

            {preview && !hardRefusal && (
              <>
                <div className={`${INSET_SURFACE} mt-3 px-3 py-2`} data-testid="coding-agent-delete-facts">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {preview.size.files === 0
                      ? t("codingAgent.delete.empty")
                      : t("codingAgent.delete.whatIsThere", {
                        // "0 B" rather than a translated phrase: it is a unit,
                        // and formatBytes answers null only for a folder whose
                        // files are all empty.
                        size: formatBytes(preview.size.bytes, locale) ?? "0 B",
                        files: preview.size.files,
                      })}
                    {preview.size.truncated && <> {t("codingAgent.delete.sizeAtLeast")}</>}
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[11px] text-[var(--text-muted)]">
                    {/* BOTH bounds, always. `retentionDays` alone read as a
                        month's guarantee, which the count bound can cut to
                        minutes — see the library header. */}
                    <li>{t("codingAgent.delete.willMove", { days: preview.retentionDays, max: preview.retentionMax })}</li>
                    {preview.secretNames.length > 0 && (
                      <li>{t("codingAgent.delete.willRemoveSecrets", { names: preview.secretNames.join(", ") })}</li>
                    )}
                    {preview.runCount > 0 && <li>{t("codingAgent.delete.willKeepRuns", { n: preview.runCount })}</li>}
                  </ul>
                </div>

                {preview.wouldPurge.length > 0 && (
                  // The shelf is full, so THIS removal deletes an older one for
                  // good — a folder still inside the thirty days it was promised.
                  // A TICK, not a warning: the thing at risk is somebody else's
                  // recoverable project, and being told is not the same as
                  // agreeing. The route refuses `trash_full` without it.
                  <div
                    className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2"
                    data-testid="coding-agent-delete-would-purge"
                  >
                    <p className="text-[11px] leading-relaxed text-amber-100">
                      {t("codingAgent.delete.willPurge", { names: preview.wouldPurge.join(", "), max: preview.retentionMax })}
                    </p>
                    <label className="mt-2.5 flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={purgeOldest}
                        onChange={(e) => setPurgeOldest(e.target.checked)}
                        data-testid="coding-agent-delete-purge-oldest"
                        className="mt-0.5"
                      />
                      <span className="text-[11px] text-amber-100">{t("codingAgent.delete.purgeOldestLabel")}</span>
                    </label>
                  </div>
                )}

                {unsavedOnly && unsaved && (
                  // EXACTLY what would be lost, before the flag that would lose
                  // it is offered at all.
                  <div
                    className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2"
                    data-testid="coding-agent-delete-unsaved"
                  >
                    <p className="text-xs font-medium text-amber-200">{t("codingAgent.delete.unsavedTitle")}</p>
                    <ul className="mt-1.5 space-y-1 text-[11px] text-amber-100/80">
                      {unsaved.notARepository && <li>{t("codingAgent.delete.unsavedNoGit")}</li>}
                      {unsaved.dirtyCount > 0 && (
                        <li>
                          {t("codingAgent.delete.unsavedDirty", { n: unsaved.dirtyCount })}
                          <span className="block break-all opacity-80">
                            {unsaved.dirty.join(", ")}
                            {unsaved.dirtyTruncated && ` ${t("codingAgent.delete.andMore")}`}
                          </span>
                        </li>
                      )}
                      {(unsaved.unpushed ?? 0) > 0 && <li>{t("codingAgent.delete.unsavedUnpushed", { n: unsaved.unpushed ?? 0 })}</li>}
                      {unsaved.stashes > 0 && <li>{t("codingAgent.delete.unsavedStashes", { n: unsaved.stashes })}</li>}
                      {/* Named one by one, because git ignores `node_modules/`
                          and `app.db` by the same rule and only the owner can
                          tell which of theirs is the only copy. */}
                      {unsaved.ignoredCount > 0 && (
                        <li>
                          {t("codingAgent.delete.unsavedIgnored", { n: unsaved.ignoredCount })}
                          <span className="block break-all opacity-80">
                            {unsaved.ignored.join(", ")}
                            {unsaved.ignoredTruncated && ` ${t("codingAgent.delete.andMore")}`}
                          </span>
                        </li>
                      )}
                      {unsaved.worktrees.length > 0 && (
                        <li>{t("codingAgent.delete.unsavedWorktrees", { names: unsaved.worktrees.join(", ") })}</li>
                      )}
                    </ul>
                    <label className="mt-2.5 flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={force}
                        onChange={(e) => setForce(e.target.checked)}
                        data-testid="coding-agent-delete-force"
                        className="mt-0.5"
                      />
                      <span className="text-[11px] text-amber-100">{t("codingAgent.delete.forceLabel")}</span>
                    </label>
                  </div>
                )}

                <label htmlFor={nameFieldId} className="mt-3 block text-xs text-[var(--text-secondary)]">
                  {t("codingAgent.delete.typeName", { folder })}
                </label>
                <input
                  id={nameFieldId}
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="coding-agent-delete-name"
                  className="mt-1 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-white/20"
                />
              </>
            )}

            {failure && (
              <p
                className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200"
                data-testid="coding-agent-delete-error"
                data-refusal={failure.code}
              >
                {refusalText(failure.code, failure.message)}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={BTN_SECONDARY} data-testid="coding-agent-delete-cancel">
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={!canRemove}
                className={BTN_DANGER}
                data-testid="coding-agent-delete-confirm"
              >
                {busy ? t("codingAgent.delete.removing") : t("codingAgent.delete.remove")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
