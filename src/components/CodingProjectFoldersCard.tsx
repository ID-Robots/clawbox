"use client";

/**
 * A project's FOLDERS on its page (TASK-2757, src/lib/project-folders.ts): the
 * git repositories of the owner's project folder that a run on this project
 * gets a copy of each of, side by side — like a VS Code multi-root workspace.
 *
 * A small list and two gestures, nothing else: "Add folder" picks one of the
 * owner's other project folders, the × beside a folder takes it off the list.
 * A project with no list is a single-folder project and shows its own folder
 * alone; taking every added folder off makes it one again.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTr } from "@/lib/i18n-floor";
import { SECRET_SCOPE_RE } from "@/lib/project-secrets-shape";
import { BTN_QUIET, CARD_SURFACE } from "./coding-agent-ui";

interface Folder {
  folder: string;
  base?: string;
}

export default function CodingProjectFoldersCard({ project, candidates }: {
  /** The project's folder name. */
  project: string;
  /** The owner's other folder projects — what "Add folder" offers. */
  candidates: string[];
}) {
  const tr = useTr();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A read that started for another project must not paint over this one.
  const scope = useRef(0);

  const load = useCallback(async () => {
    const mine = ++scope.current;
    try {
      const res = await fetch(`/setup-api/coding-agent/project-folders?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (mine !== scope.current) return;
      const data = await res.json().catch(() => null) as { folders?: Folder[]; error?: unknown } | null;
      // Asked again after the body: a later read (Retry) may have answered first.
      if (mine !== scope.current) return;
      if (!res.ok || !data) {
        setError(tr("codingAgent.folders.loadFailed", "Could not read this project's folders."));
        return;
      }
      setFolders(Array.isArray(data.folders) ? data.folders : []);
      setError(null);
    } catch {
      if (mine === scope.current) setError(tr("codingAgent.folders.loadFailed", "Could not read this project's folders."));
    }
  }, [project, tr]);

  useEffect(() => {
    if (!SECRET_SCOPE_RE.test(project)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { scope.current++; };
  }, [load, project]);

  const change = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/project-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, ...body }),
      });
      const data = await res.json().catch(() => null) as { folders?: Folder[]; error?: unknown } | null;
      if (!res.ok || !data) {
        setError(typeof data?.error === "string" && data.error ? data.error : tr("codingAgent.folders.saveFailed", "The change could not be saved."));
        return;
      }
      setFolders(Array.isArray(data.folders) ? data.folders : []);
      setPicking(false);
    } catch {
      setError(tr("codingAgent.folders.saveFailed", "The change could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  if (!SECRET_SCOPE_RE.test(project)) return null;
  // With no list, the project is its own one folder.
  const shown: Folder[] = folders && folders.length ? folders : [{ folder: project }];
  const multi = !!folders && folders.length > 0;
  const offer = candidates.filter((c) => SECRET_SCOPE_RE.test(c) && !shown.some((f) => f.folder === c));

  return (
    <div className={`mt-2 ${CARD_SURFACE} px-3 py-2`} data-testid="coding-project-folders">
      <div className="flex items-center gap-2 min-h-[32px]">
        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">folder_copy</span>
        <span className="text-xs font-semibold text-[var(--text-primary)]">{tr("codingAgent.folders.title", "Folders")}</span>
        {offer.length > 0 && (
          <button
            type="button"
            onClick={() => setPicking((on) => !on)}
            disabled={busy || folders === null}
            aria-expanded={picking}
            data-testid="coding-project-folders-add"
            className={`${BTN_QUIET} ml-auto`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">add</span>
            {tr("codingAgent.folders.add", "Add folder")}
          </button>
        )}
      </div>
      <ul className="mt-1 space-y-1 text-[11px]" data-testid="coding-project-folders-list">
        {shown.map((f) => (
          <li key={f.folder} className="flex items-center gap-2 min-h-[28px]" data-testid={`coding-project-folder-${f.folder}`}>
            <span className="font-mono text-[var(--text-primary)] truncate">{f.folder}</span>
            {f.base && <span className="text-[var(--text-muted)]">{tr("codingAgent.folders.base", "from {base}", { base: f.base })}</span>}
            {multi && (
              <button
                type="button"
                onClick={() => void change({ action: "remove", folder: f.folder })}
                disabled={busy}
                aria-label={tr("codingAgent.folders.remove", "Remove {folder}", { folder: f.folder })}
                title={tr("codingAgent.folders.remove", "Remove {folder}", { folder: f.folder })}
                data-testid={`coding-project-folder-remove-${f.folder}`}
                className={`${BTN_QUIET} ml-auto`}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {picking && (
        <ul className="mt-1 border-t border-white/10 pt-1 space-y-0.5 text-[11px]" data-testid="coding-project-folders-pick">
          {offer.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => void change({ action: "add", folder: name })}
                disabled={busy}
                data-testid={`coding-project-folders-pick-${name}`}
                className={`${BTN_QUIET} w-full justify-start font-mono`}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">add</span>
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-[11px] text-red-300" role="alert" data-testid="coding-project-folders-error">{error}</p>}
      {/* The list could not be read: nothing may change until it is, and this reads it again. */}
      {error && folders === null && (
        <button type="button" onClick={() => void load()} data-testid="coding-project-folders-retry" className={`${BTN_QUIET} mt-1`}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">refresh</span>
          {tr("retry", "Retry")}
        </button>
      )}
    </div>
  );
}
