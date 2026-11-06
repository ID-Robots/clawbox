"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_SECONDARY } from "./coding-agent-ui";

interface BrowseAnswer {
  root: string;
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/**
 * The folder picker Memory Shard's Folders card uses, over the same route
 * (`/setup-api/coding-agent/browse`, the browse root's rule): a list of folders
 * with Remove per row and "Add a folder" opening a walkable listing. The list
 * itself belongs to the host — the ingest form holds it in memory, the
 * settings page saves it — so this only reports the change. "Your home
 * folder" adds the browse root (the owner's home) in one click.
 */
export default function PrimeRadiantFolderPicker({ folders, onChange, max, disabled, testId }: {
  folders: string[];
  onChange: (next: string[]) => void;
  max: number;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useT();
  const [browse, setBrowse] = useState<BrowseAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const open = useCallback(async (dir?: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      let res = await fetch(`/setup-api/coding-agent/browse${qs}`, { signal: ctl.signal });
      if (res.status === 404 && dir) res = await fetch("/setup-api/coding-agent/browse", { signal: ctl.signal });
      if (!res.ok) throw new Error("browse");
      const answer = (await res.json()) as BrowseAnswer;
      setHome(answer.root);
      setBrowse(answer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(t("primeRadiant.folders.browseFailed"));
    }
  }, [t]);

  const add = (dir: string) => {
    if (!folders.includes(dir)) onChange([...folders, dir]);
    setBrowse(null);
  };

  /** The browse root is the owner's home folder: ask for it (once) and add it. */
  const addHome = async () => {
    if (home) return add(home);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/browse", { signal: ctl.signal });
      if (!res.ok) throw new Error("browse");
      const { root } = (await res.json()) as BrowseAnswer;
      setHome(root);
      add(root);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(t("primeRadiant.folders.browseFailed"));
    }
  };

  return (
    <div data-testid={testId}>
      <ul className="space-y-1.5">
        {folders.map((folder) => (
          <li key={folder} className="flex items-center gap-2 rounded-lg bg-black/25 border border-white/[0.06] px-3 py-2">
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 15 }} aria-hidden="true">folder</span>
            <span className="flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">{folder}</span>
            <button type="button" className={BTN_SECONDARY} disabled={disabled} onClick={() => onChange(folders.filter((f) => f !== folder))}>
              {t("primeRadiant.folders.remove")}
            </button>
          </li>
        ))}
        {folders.length === 0 && <li className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.folders.none")}</li>}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={disabled || folders.length >= max}
          onClick={() => void open()}
          data-testid={`${testId}-add`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">create_new_folder</span>
          {t("primeRadiant.folders.add")}
        </button>
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={disabled || folders.length >= max || (home !== null && folders.includes(home))}
          onClick={() => void addHome()}
          data-testid={`${testId}-home`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">home</span>
          {t("primeRadiant.folders.home")}
        </button>
      </div>
      {browse && (
        <div className="mt-2 rounded-xl bg-black/25 border border-white/[0.06] p-2" data-testid={`${testId}-browser`}>
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <span className="font-mono text-[11px] text-[var(--text-muted)] truncate">{browse.path}</span>
            <button type="button" className={BTN_SECONDARY} onClick={() => setBrowse(null)}>{t("primeRadiant.folders.close")}</button>
          </div>
          <ul className="max-h-48 overflow-y-auto">
            {browse.parent && (
              <li>
                <button type="button" onClick={() => void open(browse.parent as string)}
                  className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-white/5 cursor-pointer">
                  {t("primeRadiant.folders.up")}
                </button>
              </li>
            )}
            {browse.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => void open(entry.path)}
                  className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-primary)] hover:bg-white/5 cursor-pointer">
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={`${BTN_SECONDARY} mt-1 w-full`} onClick={() => add(browse.path)} data-testid={`${testId}-use`}>
            {t("primeRadiant.folders.use")}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}
