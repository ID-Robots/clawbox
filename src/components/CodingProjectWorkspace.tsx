"use client";

/**
 * The project page's workspace: the folder as a tree, and what changed as a
 * diff — the two panes the Claude Code web app puts beside a session, here
 * beside a project's runs.
 *
 * Files reads the project through `/setup-api/coding-agent/tree`, which is
 * rooted at the PROJECT (a project can live anywhere the owner pointed the
 * agent at, so the Files app's home-rooted route is the wrong walk), with
 * the Files app's own icons so a folder looks the same in both. A file
 * opens read-only beside the tree: a run edits, the owner reads.
 *
 * Changes reads `/setup-api/coding-agent/git?changes`: the working tree while
 * a run is in flight (polled, so the list grows as the run writes), and once
 * it has settled, the commit it made — a run commits its work the moment it
 * finishes, which leaves the tree clean and the work in history. The picker
 * at the top switches between "uncommitted" and the recent commits, and a
 * file in the list opens its unified diff, coloured line by line.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { ChangedFile, ChangeStatus, CommitSummary, FileDiff, GitChanges } from "@/lib/coding-git";
import type { TreeEntry, TreeFile, TreeListing } from "@/lib/coding-project-tree";
import { fileIcon, formatSize, Icon } from "./file-icons";
import CodeEditor from "./CodeEditor";
import { languageForFile } from "@/lib/code-language";
import { dispatchOpenApp } from "@/lib/ui-events";
import { CARD_SURFACE, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";
import { timeAgo } from "./clawkeep-ui";

export type WorkspaceTab = "files" | "changes" | "runs" | "team";

interface Props {
  /** `projectId=<id>` for a code project, `directory=<abs>` for a folder —
   *  the same query the page's git block sends. */
  query: string;
  /** A run is working in the folder: the change list follows it. */
  live: boolean;
  /** The commit to open the Changes tab on — a settled run's own. */
  initialRef?: string | null;
  initialTab?: WorkspaceTab;
  /** Take the height of the column this sits in instead of a fixed cap. */
  fill?: boolean;
  /** The project's folder as the Files app can be pointed at it; absent, no "Open in Files". */
  filesDirectory?: string;
  /** The project's runs, as a tab of their own — the page hands the list in
   *  so the rows stay the one list home also draws. Absent: no tab. */
  runs?: ReactNode;
  /** How many runs the Runs tab holds, for its label. */
  runsCount?: number;
  /** One of them is working: the tab carries a live dot. */
  runsLive?: boolean;
  /** The coding team's card, as a tab. Absent: no tab. */
  team?: ReactNode;
}

/** How often the change list is re-read while a run is writing. */
const LIVE_POLL_MS = 5000;

const STATUS_GLYPH: Record<ChangeStatus, { letter: string; className: string }> = {
  modified: { letter: "M", className: "text-amber-300" },
  added: { letter: "A", className: "text-emerald-300" },
  untracked: { letter: "A", className: "text-emerald-300" },
  deleted: { letter: "D", className: "text-red-300" },
  conflict: { letter: "!", className: "text-red-400" },
};

export default function CodingProjectWorkspace({ query, live, initialRef = null, initialTab, fill = false, filesDirectory, runs, runsCount = 0, runsLive = false, team }: Props) {
  const { t } = useT();
  // The project page opens on its RUNS — what the owner comes to a project
  // for — and the files and the changes are one tab away; a host that hands
  // no runs (a run's own page) opens on the files.
  const [tab, setTab] = useState<WorkspaceTab>(initialTab ?? (runs ? "runs" : "files"));
  const tabClass = (id: WorkspaceTab) => (tab === id ? SEGMENT_ON : SEGMENT_OFF);
  const panelClass = fill ? "flex-1 min-h-0 flex flex-col" : undefined;
  // The pane's height: a fixed cap inside a scrolling page, or the column's
  // own height when the page hands it one — the files are what the page is
  // for, and a 28rem strip under a 60rem window was the complaint.
  const paneClass = fill ? "flex-1 min-h-[22rem] @3xl:min-h-0" : "max-h-[28rem]";
  return (
    <div className={`mt-3 ${fill ? "flex-1 min-h-0 flex flex-col" : ""}`} data-testid="coding-agent-workspace" data-fill={fill || undefined}>
      <div className={`${SEGMENTED_TRACK} ${runs || team ? "max-w-xl" : "max-w-xs"}`} role="tablist" aria-label={t("codingAgent.workspaceTitle")}>
        {/* The runs and the team are tabs too, not a rail: the rail was
            22rem wide, and a run's row in it wrapped its title three deep
            and its figures six. Every tab has the whole width now — and the
            runs come FIRST: they are what the owner opens a project for. */}
        {runs && (
          <button
            type="button"
            role="tab"
            id="coding-agent-workspace-tab-runs"
            aria-selected={tab === "runs"}
            aria-controls="coding-agent-workspace-pane-runs"
            onClick={() => setTab("runs")}
            data-testid="coding-agent-workspace-runs"
            className={tabClass("runs")}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">history</span>
            {t("codingAgent.runsTab")}
            <span className="text-[var(--text-muted)] font-normal">({runsCount})</span>
            {runsLive && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" data-testid="coding-agent-workspace-runs-live" />}
          </button>
        )}
        <button
          type="button"
          role="tab"
          id="coding-agent-workspace-tab-files"
          aria-selected={tab === "files"}
          aria-controls="coding-agent-workspace-pane-files"
          onClick={() => setTab("files")}
          data-testid="coding-agent-workspace-files"
          className={tabClass("files")}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">folder_open</span>
          {t("codingAgent.filesTab")}
        </button>
        <button
          type="button"
          role="tab"
          id="coding-agent-workspace-tab-changes"
          aria-selected={tab === "changes"}
          aria-controls="coding-agent-workspace-pane-changes"
          onClick={() => setTab("changes")}
          data-testid="coding-agent-workspace-changes"
          className={tabClass("changes")}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">difference</span>
          {t("codingAgent.changesTab")}
        </button>
        {team && (
          <button
            type="button"
            role="tab"
            id="coding-agent-workspace-tab-team"
            aria-selected={tab === "team"}
            aria-controls="coding-agent-workspace-pane-team"
            onClick={() => setTab("team")}
            data-testid="coding-agent-workspace-team"
            className={tabClass("team")}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">groups</span>
            {t("codingAgent.teamTab")}
          </button>
        )}
      </div>
      {/* Both panes stay mounted: a tree that was opened three folders deep
          would otherwise fold every time the owner glanced at the diff. */}
      <div role="tabpanel" id="coding-agent-workspace-pane-files" aria-labelledby="coding-agent-workspace-tab-files" hidden={tab !== "files"} className={panelClass}>
        <FilesPane query={query} live={live} directory={filesDirectory} paneClass={paneClass} fill={fill} />
      </div>
      <div role="tabpanel" id="coding-agent-workspace-pane-changes" aria-labelledby="coding-agent-workspace-tab-changes" hidden={tab !== "changes"} className={panelClass}>
        <ChangesPane query={query} live={live} initialRef={initialRef} active={tab === "changes"} paneClass={paneClass} fill={fill} />
      </div>
      {runs && (
        <div role="tabpanel" id="coding-agent-workspace-pane-runs" aria-labelledby="coding-agent-workspace-tab-runs" hidden={tab !== "runs"} className={fill ? "flex-1 min-h-0 overflow-y-auto" : undefined}>
          {runs}
        </div>
      )}
      {team && (
        <div role="tabpanel" id="coding-agent-workspace-pane-team" aria-labelledby="coding-agent-workspace-tab-team" hidden={tab !== "team"} className={fill ? "flex-1 min-h-0 overflow-y-auto" : undefined}>
          {team}
        </div>
      )}
    </div>
  );
}

// ─── Files ──────────────────────────────────────────────────────────────────

type Node = { path: string; entry: TreeEntry; depth: number };

function FilesPane({ query, live, directory, paneClass, fill }: { query: string; live: boolean; directory?: string; paneClass: string; fill: boolean }) {
  const { t } = useT();
  const [listings, setListings] = useState<Record<string, TreeListing>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const [failed, setFailed] = useState<string | null>(null);
  const [file, setFile] = useState<TreeFile | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  // The text as the owner has it; null while nothing editable is open.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A file tapped while the open one carries unsaved changes: asked about
  // before it replaces them, never opened over them.
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [filesBusy, setFilesBusy] = useState(false);

  const load = useCallback(async (rel: string) => {
    try {
      const res = await fetch(`/setup-api/coding-agent/tree?${query}&path=${encodeURIComponent(rel)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { listing?: TreeListing; error?: string } | null;
      if (!res.ok || !data?.listing) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      setListings((prev) => ({ ...prev, [rel]: data.listing! }));
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    }
  }, [query, t]);

  useEffect(() => { void load(""); }, [load]);

  const toggle = (rel: string) => {
    // The updater stays pure — React may run it twice — and the read
    // happens once, here, only when the folder opens for the first time.
    const opening = !open.has(rel);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
    if (opening && !listings[rel]) void load(rel);
  };

  // A binary file has nothing to edit; a cut one must not be saved back cut.
  const editable = !!file && !file.binary && !file.truncated;
  const dirty = editable && draft !== null && draft !== file!.content;

  const readFile = async (rel: string) => {
    setFileBusy(rel);
    try {
      const res = await fetch(`/setup-api/coding-agent/tree?${query}&file=${encodeURIComponent(rel)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { file?: TreeFile; error?: string } | null;
      if (!res.ok || !data?.file) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      setFile(data.file);
      setDraft(data.file.binary || data.file.truncated ? null : data.file.content);
      setSaved(false);
      setSaveError(null);
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    } finally {
      setFileBusy(null);
    }
  };

  const openFile = (rel: string) => {
    if (dirty) { setPendingOpen(rel); return; }
    void readFile(rel);
  };

  const save = useCallback(async () => {
    if (!file || !dirty || draft === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const params = new URLSearchParams(query);
      const res = await fetch("/setup-api/coding-agent/tree", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: params.get("projectId"), directory: params.get("directory"), file: file.path, content: draft }),
      });
      const data = await res.json().catch(() => null) as { file?: { path: string; size: number }; error?: string } | null;
      if (!res.ok || !data?.file) throw new Error(data?.error ?? t("codingAgent.fileSaveFailed"));
      setFile({ ...file, content: draft, size: data.file.size });
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("codingAgent.fileSaveFailed"));
    } finally {
      setSaving(false);
    }
  }, [file, dirty, draft, saving, query, t]);

  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(id);
  }, [saved]);

  // The Files app browses from the owner's home; the project folder is
  // named to it as the Files route knows it, then a Files window of its
  // own opens there (a plain `openApp` would only raise the one already up).
  const openInFiles = async () => {
    if (!directory || filesBusy) return;
    setFilesBusy(true);
    try {
      const res = await fetch("/setup-api/files?dir=", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resolve", filePath: directory }),
      });
      const data = await res.json().catch(() => null) as { relPath?: string; error?: string } | null;
      if (!res.ok || typeof data?.relPath !== "string") throw new Error(t("codingAgent.openInFilesFailed"));
      dispatchOpenApp("files", { forceNew: true, meta: { path: data.relPath } });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : t("codingAgent.openInFilesFailed"));
    } finally {
      setFilesBusy(false);
    }
  };

  // The tree, flattened in render order: a folder's children follow it while
  // it is open. Depth draws the indent.
  const rows = useMemo(() => {
    const out: Node[] = [];
    const walk = (rel: string, depth: number) => {
      const listing = listings[rel];
      if (!listing) return;
      for (const entry of listing.entries) {
        const p = rel ? `${rel}/${entry.name}` : entry.name;
        out.push({ path: p, entry, depth });
        if (entry.type === "directory" && open.has(p)) walk(p, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [listings, open]);

  const root = listings[""];
  return (
    <div className={`mt-2 ${CARD_SURFACE} overflow-hidden @3xl:grid @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] ${fill ? "flex-1 min-h-0" : ""}`}>
      <div className={`${paneClass} overflow-y-auto border-b @3xl:border-b-0 @3xl:border-r border-white/[0.06]`} data-testid="coding-agent-file-tree">
        {directory && (
          <div className="flex items-center justify-end px-2 py-1 border-b border-white/[0.06]">
            <button
              type="button"
              onClick={() => void openInFiles()}
              disabled={filesBusy}
              data-testid="coding-agent-open-in-files"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] disabled:opacity-50"
              title={t("codingAgent.openInFiles")}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">folder_open</span>
              {t("codingAgent.openInFiles")}
            </button>
          </div>
        )}
        {failed && !root && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
        {root && root.entries.length === 0 && <p className="px-3 py-2 text-[11px] text-[var(--text-muted)]">{t("codingAgent.emptyFolder")}</p>}
        <ul role="tree" className="py-1">
          {rows.map(({ path, entry, depth }) => {
            const isDir = entry.type === "directory";
            const expanded = isDir && open.has(path);
            const icon = fileIcon(entry.name, entry.type);
            const current = file?.path === path;
            return (
              <li key={path} role="presentation">
                <button
                  type="button"
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={isDir ? expanded : undefined}
                  aria-selected={current || undefined}
                  onClick={() => (isDir ? toggle(path) : openFile(path))}
                  data-testid={`coding-agent-tree-${path}`}
                  title={path}
                  className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left text-[12px] hover:bg-white/[0.05] ${current ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
                  style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
                >
                  {isDir ? (
                    <span className="material-symbols-rounded text-[var(--text-muted)] shrink-0" style={{ fontSize: 14 }} aria-hidden="true">
                      {expanded ? "expand_more" : "chevron_right"}
                    </span>
                  ) : (
                    <span className="w-[14px] shrink-0" aria-hidden="true" />
                  )}
                  <Icon name={expanded ? "folder_open" : icon.icon} size={16} color={icon.color} />
                  <span className="truncate">{entry.name}</span>
                  {fileBusy === path && <span className="ml-auto material-symbols-rounded animate-spin text-[var(--text-muted)]" style={{ fontSize: 12 }} aria-hidden="true">progress_activity</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {root?.truncated && <p className="px-3 py-1.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.listTruncated")}</p>}
      </div>
      <div className={`min-w-0 min-h-[8rem] ${paneClass} overflow-auto flex flex-col`} data-testid="coding-agent-file-view" data-dirty={dirty || undefined}>
        {failed && root && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
        {!file ? (
          <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.pickFile")}</p>
        ) : (
          <>
            <div className="sticky top-0 left-0 z-10 flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-[var(--win-ground)] text-[11px]">
              <span className="font-mono text-[var(--text-primary)] truncate">{file.path}</span>
              <span className="text-[var(--text-muted)] shrink-0">{formatSize(file.size)}</span>
              {file.truncated && <span className="text-amber-300 shrink-0" title={t("codingAgent.fileReadOnlyLarge")}>{t("codingAgent.fileTruncated")}</span>}
              {editable && (
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {dirty && <span className="text-[var(--text-muted)]" title={t("codingAgent.fileUnsaved")} data-testid="coding-agent-file-dirty">●</span>}
                  {!dirty && saved && <span className="text-emerald-300" data-testid="coding-agent-file-saved">{t("codingAgent.fileSaved")}</span>}
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                    data-testid="coding-agent-file-save"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 border border-white/[0.08] bg-white/[0.06] text-[var(--text-primary)] hover:bg-white/[0.12] disabled:opacity-40"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">save</span>
                    {saving ? t("codingAgent.fileSaving") : t("codingAgent.fileSave")}
                  </button>
                </span>
              )}
            </div>
            {editable && live && (
              <p className="sticky left-0 px-3 py-1 text-[11px] text-amber-300/90 border-b border-white/[0.06]" data-testid="coding-agent-file-live-note">{t("codingAgent.fileLiveEdit")}</p>
            )}
            {saveError && <p className="sticky left-0 px-3 py-1 text-[11px] text-red-300" data-testid="coding-agent-file-save-error">{saveError}</p>}
            {pendingOpen !== null && (
              <div className="sticky left-0 flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11px] text-amber-200 bg-amber-500/10 border-b border-amber-400/20" data-testid="coding-agent-file-discard-bar">
                <span>{t("codingAgent.fileDiscardAsk", { file: file.path })}</span>
                <button type="button" onClick={() => setPendingOpen(null)} data-testid="coding-agent-file-keep" className="rounded-md px-2 py-0.5 border border-white/[0.08] bg-white/[0.06] hover:bg-white/[0.12] text-[var(--text-primary)]">{t("codingAgent.fileKeepEditing")}</button>
                <button type="button" onClick={() => { const rel = pendingOpen; setPendingOpen(null); void readFile(rel); }} data-testid="coding-agent-file-discard" className="rounded-md px-2 py-0.5 border border-red-400/30 bg-red-500/15 hover:bg-red-500/25 text-red-200">{t("codingAgent.fileDiscard")}</button>
              </div>
            )}
            {file.binary ? (
              <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.binaryFile")}</p>
            ) : editable ? (
              <CodeEditor value={draft ?? file.content} onChange={setDraft} language={languageForFile(file.path)} onSave={() => void save()} ariaLabel={file.path} testId="coding-agent-file-editor" className="flex-1" />
            ) : (
              <CodeEditor value={file.content} language={languageForFile(file.path)} testId="coding-agent-file-editor" className="flex-1" />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Changes ────────────────────────────────────────────────────────────────

function ChangesPane({ query, live, initialRef, active, paneClass, fill }: { query: string; live: boolean; initialRef: string | null; active: boolean; paneClass: string; fill: boolean }) {
  const { t } = useT();
  // "" is the working tree; otherwise a commit's sha.
  const [ref, setRef] = useState<string>(initialRef ?? "");
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [log, setLog] = useState<CommitSummary[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await fetch(`/setup-api/coding-agent/git?${query}&changes=1${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { changes?: GitChanges; log?: CommitSummary[]; error?: string } | null;
      if (mine !== generation.current) return;
      if (!res.ok || !data?.changes) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      setChanges(data.changes);
      setLog(data.log ?? []);
      setFailed(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    }
  }, [query, ref, t]);

  // Read only once the tab is open: the page's git block is read on every
  // project page, and a second git read for a pane nobody is looking at is
  // three more spawns on a Jetson.
  useEffect(() => { if (active) void load(); }, [active, load]);

  // A run in flight writes as it goes; the list follows while it is on screen.
  useEffect(() => {
    if (!live || !active || ref) return;
    const id = setInterval(() => { void load(); }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [live, active, ref, load]);

  // A settled run's commit arrives after the page opened on the working tree.
  useEffect(() => {
    if (initialRef) { setRef(initialRef); setSelected(null); setDiff(null); }
  }, [initialRef]);

  const openDiff = useCallback(async (file: string) => {
    setSelected(file);
    setDiffBusy(true);
    try {
      const res = await fetch(`/setup-api/coding-agent/git?${query}&diff=${encodeURIComponent(file)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { diff?: FileDiff; error?: string } | null;
      if (!res.ok || !data?.diff) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      setDiff(data.diff);
      setFailed(null);
    } catch (err) {
      setDiff(null);
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    } finally {
      setDiffBusy(false);
    }
  }, [query, ref, t]);

  const files = changes?.files ?? [];
  return (
    <div className={`mt-2 ${CARD_SURFACE} overflow-hidden ${fill ? "flex-1 min-h-0 flex flex-col" : ""}`}>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] text-[11px]">
        <label className="flex items-center gap-1.5 min-w-0">
          <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 14 }} aria-hidden="true">commit</span>
          <select
            value={ref}
            onChange={(e) => { setRef(e.target.value); setSelected(null); setDiff(null); }}
            aria-label={t("codingAgent.changePicker")}
            data-testid="coding-agent-change-picker"
            className="bg-transparent text-[var(--text-primary)] text-[11px] max-w-[20rem] truncate outline-none"
          >
            <option value="" className="bg-[var(--win-ground)]">{t("codingAgent.uncommitted")}</option>
            {log.map((c) => (
              <option key={c.sha} value={c.sha} className="bg-[var(--win-ground)]">
                {c.subject.slice(0, 60)} · {timeAgo(c.date, t)}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-[var(--text-muted)] shrink-0" data-testid="coding-agent-change-totals">
          {changes?.available && files.length > 0 && (
            <>
              {t("codingAgent.filesChanged", { n: files.length })}
              <span className="text-emerald-300"> +{changes.additions}</span>
              <span className="text-red-300"> −{changes.deletions}</span>
            </>
          )}
        </span>
      </div>
      <div className={`@3xl:grid @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] ${fill ? "flex-1 min-h-0" : ""}`}>
        <div className={`${paneClass} overflow-y-auto border-b @3xl:border-b-0 @3xl:border-r border-white/[0.06]`} data-testid="coding-agent-change-list">
          {failed && !changes && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {changes && !changes.available && <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noGitHistory")}</p>}
          {changes?.available && files.length === 0 && <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noChanges")}</p>}
          <ul className="py-1">
            {files.map((f) => <ChangeRow key={f.path} file={f} selected={selected === f.path} onOpen={() => void openDiff(f.path)} />)}
          </ul>
          {changes?.truncated && <p className="px-3 py-1.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.listTruncated")}</p>}
        </div>
        <div className={`min-w-0 min-h-[8rem] ${paneClass} overflow-auto`} data-testid="coding-agent-diff-view">
          {failed && changes && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {!selected ? (
            <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{files.length > 0 ? t("codingAgent.pickDiff") : ""}</p>
          ) : diffBusy && !diff ? (
            <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">…</p>
          ) : diff ? (
            <>
              <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-[var(--win-ground)] text-[11px]">
                <span className="font-mono text-[var(--text-primary)] truncate">{diff.path}</span>
                {diff.truncated && <span className="text-amber-300 shrink-0">{t("codingAgent.diffTruncated")}</span>}
              </div>
              {diff.binary ? (
                <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.binaryFile")}</p>
              ) : diff.diff ? (
                <DiffView text={diff.diff} />
              ) : (
                <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noChanges")}</p>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChangeRow({ file, selected, onOpen }: { file: ChangedFile; selected: boolean; onOpen: () => void }) {
  const { t } = useT();
  const glyph = STATUS_GLYPH[file.status];
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid={`coding-agent-change-${file.path}`}
        title={file.path}
        className={`w-full flex items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-white/[0.05] ${selected ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
      >
        <span className={`w-3 shrink-0 font-mono font-semibold text-[11px] ${glyph.className}`} title={t(`codingAgent.change.${file.status}`)} aria-label={t(`codingAgent.change.${file.status}`)}>
          {glyph.letter}
        </span>
        <span className="truncate min-w-0">
          {dir && <span className="text-[var(--text-muted)]">{dir}</span>}
          {name}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px]">
          {file.additions !== null && <span className="text-emerald-300">+{file.additions}</span>}
          {file.deletions !== null && file.deletions > 0 && <span className="text-red-300"> −{file.deletions}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * A unified diff, line by line: additions green, removals red, hunk headers
 * muted, the file header folded away. Text only — `git diff` output is what
 * a run wrote, and it is never rendered as anything but characters.
 */
export function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="text-[11.5px] leading-[1.45] font-mono py-1" data-testid="coding-agent-diff">
      {lines.map((line, i) => {
        if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity") || line.startsWith("rename ")) {
          return null;
        }
        const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        const cls = kind === "add"
          ? "bg-emerald-500/[0.12] text-emerald-200"
          : kind === "del"
            ? "bg-red-500/[0.12] text-red-200"
            : kind === "hunk"
              ? "text-sky-300/80 bg-white/[0.03]"
              : "text-[var(--text-secondary)]";
        return (
          <div key={i} className={`px-3 whitespace-pre-wrap break-all ${cls}`} data-diff-line={kind}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </pre>
  );
}
