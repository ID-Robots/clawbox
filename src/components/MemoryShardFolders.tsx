"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";
import { BTN_SECONDARY } from "./coding-agent-ui";

/**
 * The folders Memory Shard reads beside the box's own notes and conversations:
 * the list, Remove per row, and "Add a folder" with the picker behind it.
 *
 * ONE component for the wizard's folders step and the settings page's Folders
 * card, so the two cannot drift — before this the list lived only in the
 * wizard, and once setup was over there was no way to see or change it
 * (ms-findings F-D).
 *
 * ONE busy state for everything here. A write to the list is a ~5 s CLI spawn
 * the gateway restarts on, and the sweep watched a second click land while
 * the first was still going: the buttons were merely `disabled`, with no
 * word about what was happening, and the picker stayed open inviting the
 * next tap (F-A). So while an add or a remove is in flight every folder
 * control is disabled, the pressed button says what it is doing, the picker
 * closes only when the add SUCCEEDED, and a refused add or remove says so
 * (F-G) — the route's own sentence when it sent one.
 */

interface BrowseAnswer {
  root: string;
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/** What is in flight, if anything: the add, or the remove of ONE folder. */
type Busy = { kind: "add" } | { kind: "remove"; folder: string };

interface SourcesAnswer { paths?: string[]; error?: string }

/**
 * `onBusyChange` tells a host whether a write is in flight, so a control the
 * host owns can wait too — the wizard's Next, which used to let the owner
 * leave the step while an add was still being answered and never see its
 * refusal.
 */
export default function MemoryShardFolders({ onBusyChange }: { onBusyChange?: (busy: boolean) => void } = {}) {
  const { t } = useT();
  const [sources, setSources] = useState<string[]>([]);
  const [browse, setBrowse] = useState<BrowseAnswer | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browseAbort = useRef<AbortController | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/clawkeep/memory/sources");
      if (res.ok) setSources(((await res.json()) as SourcesAnswer).paths ?? []);
    } catch {
      // An unreadable list is an empty one here; the controls still work.
    }
  }, []);
  useEffect(() => { void loadSources(); }, [loadSources]);
  useEffect(() => () => browseAbort.current?.abort(), []);
  // Reported from an effect rather than beside each setBusy, so the host is
  // told on the render that shows the lock and told "free" once on unmount
  // mid-write — the write goes on, but nothing here is left to lock.
  useEffect(() => {
    onBusyChange?.(busy !== null);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const openBrowse = useCallback(async (dir?: string) => {
    browseAbort.current?.abort();
    const ctl = new AbortController();
    browseAbort.current = ctl;
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      let res = await fetch(`/setup-api/coding-agent/browse${qs}`, { signal: ctl.signal });
      // A folder that has gone since it was listed: fall back to the root
      // rather than leaving the picker on a listing that cannot be opened.
      if (res.status === 404 && dir) res = await fetch("/setup-api/coding-agent/browse", { signal: ctl.signal });
      if (!res.ok) throw new Error(t("clawkeep.memory.setup.browseFailed"));
      setBrowse((await res.json()) as BrowseAnswer);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : t("clawkeep.memory.setup.browseFailed"));
    }
  }, [t]);

  const mutate = async (method: "POST" | "DELETE", folder: string, fallbackKey: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch("/setup-api/clawkeep/memory/sources", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folder }),
      });
      const out = (await res.json().catch(() => null)) as SourcesAnswer | null;
      if (!res.ok) throw new Error(out?.error || t(fallbackKey));
      setSources(out?.paths ?? []);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t(fallbackKey));
      return false;
    }
  };

  const addSource = async (folder: string) => {
    if (busy) return;
    setBusy({ kind: "add" });
    try {
      // The picker closes on SUCCESS only: closed on a refusal, the owner
      // would be looking at a list without the folder and no way to tell
      // whether the click was taken.
      if (await mutate("POST", folder, "clawkeep.memory.setup.addFolderFailed")) setBrowse(null);
    } finally {
      setBusy(null);
    }
  };

  const removeSource = async (folder: string) => {
    if (busy) return;
    setBusy({ kind: "remove", folder });
    try {
      await mutate("DELETE", folder, "clawkeep.memory.folders.removeFailed");
    } finally {
      setBusy(null);
    }
  };

  const locked = busy !== null;
  const removing = (folder: string) => busy?.kind === "remove" && busy.folder === folder;

  return (
    <div data-testid="memory-shard-folders">
      <ul className="mt-3 space-y-1.5" data-testid="memory-shard-sources">
        {sources.map((folder) => (
          <li key={folder} className="flex items-center gap-2 rounded-lg bg-[var(--fill-1)] border border-[var(--border-subtle)] px-3 py-2">
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 15 }} aria-hidden="true">folder</span>
            <span className="flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">{folder}</span>
            <button
              type="button"
              onClick={() => void removeSource(folder)}
              disabled={locked}
              aria-busy={removing(folder)}
              data-testid="memory-shard-folder-remove"
              className={BTN_SECONDARY}
            >
              {removing(folder) ? t("clawkeep.memory.folders.removing") : t("clawkeep.memory.setup.removeFolder")}
            </button>
          </li>
        ))}
        {sources.length === 0 && (
          <li className="text-[11px] text-[var(--text-muted)]">{t("clawkeep.memory.setup.noFolders")}</li>
        )}
      </ul>

      <button
        type="button"
        onClick={() => void openBrowse()}
        disabled={locked}
        className={`${BTN_SECONDARY} mt-3`}
        data-testid="memory-shard-browse"
      >
        <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">create_new_folder</span>
        {t("clawkeep.memory.setup.addFolder")}
      </button>

      {browse && (
        <div className="mt-2 rounded-xl bg-[var(--fill-1)] border border-[var(--border-subtle)] p-2" data-testid="memory-shard-picker">
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <span className="font-mono text-[11px] text-[var(--text-muted)] truncate">{browse.path}</span>
            <button type="button" onClick={() => setBrowse(null)} disabled={locked} className={BTN_SECONDARY}>
              {t("clawkeep.memory.setup.close")}
            </button>
          </div>
          <ul className="max-h-48 overflow-y-auto">
            {browse.parent && (
              <li>
                <button type="button" onClick={() => void openBrowse(browse.parent as string)} disabled={locked}
                  className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed">
                  {t("clawkeep.memory.setup.up")}
                </button>
              </li>
            )}
            {browse.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => void openBrowse(entry.path)} disabled={locked}
                  className="w-full text-left px-2 py-1 rounded-lg text-xs text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed">
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void addSource(browse.path)}
            disabled={locked}
            aria-busy={busy?.kind === "add"}
            data-testid="memory-shard-pick"
            className={`${BTN_SECONDARY} mt-1 w-full`}
          >
            {busy?.kind === "add" ? t("clawkeep.memory.folders.adding") : t("clawkeep.memory.setup.useFolder")}
          </button>
        </div>
      )}

      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
