"use client";

/**
 * The project page's workspace: what happened here (Activity), the folder as
 * a tree (Files) and what changed as a diff (Changes) — three tabs, no
 * inputs. The chat composes; this shows (the 2026-10-30 redesign).
 *
 * Files reads the project through `/setup-api/coding-agent/tree`, which is
 * rooted at the PROJECT (a project can live anywhere the owner pointed the
 * agent at, so the Files app's home-rooted route is the wrong walk), with
 * the Files app's own icons so a folder looks the same in both. A file opens
 * READ-ONLY: a run edits, the owner reads — and edits, when they must, in
 * the Files app, which **Open in Files** points at the folder. The editor
 * that saved through the tree route's PUT (dirty dot, Save, the discard bar)
 * went on 2026-10-30 with the owner's ruling that the app carries no inputs;
 * the PUT itself stays for the Files app.
 *
 * Changes reads `/setup-api/coding-agent/git?changes`: the working tree while
 * a run is in flight (polled, so the list grows as the run writes), and once
 * it has settled, the commit it made — a run commits its work the moment it
 * finishes, which leaves the tree clean and the work in history. A quiet
 * **Newer / Older** pair steps through the recent commits (the `<select>` it
 * replaced was an input), and a file in the list opens its unified diff,
 * coloured line by line.
 *
 * On a phone (under `@3xl`, the WINDOW's width) each tab shows ONE pane at a
 * time: the tree, then the file it opened with a way back; the list, then
 * the diff. From `@3xl` the two sit side by side.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { ChangedFile, ChangeStatus, CommitSummary, FileDiff, GitChanges } from "@/lib/coding-git";
import type { TreeEntry, TreeFile, TreeListing } from "@/lib/coding-project-tree";
import { fileIcon, formatSize, Icon } from "./file-icons";
import CodeEditor from "./CodeEditor";
import { languageForFile } from "@/lib/code-language";
import { dispatchOpenApp } from "@/lib/ui-events";
import { BTN_QUIET, CARD_SURFACE, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";
import { setVisibleInterval } from "@/lib/visible-interval";

/**
 * `team` stays until the team has a page of its own (redesign step 5): the
 * tab is a plain list of the project's teams, the last in the row.
 */
export type WorkspaceTab = "activity" | "files" | "changes" | "team";

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
  /** The project's folder, as text in the Files header (the home row and the title block carry no path). */
  directory?: string;
  /** The project's folder as the Files app can be pointed at it; absent, no "Open in Files". */
  filesDirectory?: string;
  /** What happened here — the project's teams and runs as one list — as the
   *  first tab. The page hands the rows in, so they stay the one list it
   *  draws. Absent: no tab (a run's own page). */
  activity?: ReactNode;
  /** Something in it is at work: the tab carries a live dot. */
  activityLive?: boolean;
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

/** A pane header's glyph button — the way back to the other pane on a phone, Open in Files. */
const PANE_BUTTON = `${BTN_QUIET} min-h-[36px] @md:min-h-[28px] px-2 text-[11px]`;

export default function CodingProjectWorkspace({ query, live, initialRef = null, initialTab, fill = false, directory, filesDirectory, activity, activityLive = false, team }: Props) {
  const { t } = useT();
  // The project page opens on its ACTIVITY — what happened and what is
  // happening here, teams and runs in one list — then the files and the
  // changes one tab away; a host that hands no activity (a run's own page)
  // opens on the files.
  const [tab, setTab] = useState<WorkspaceTab>(initialTab ?? (activity ? "activity" : "files"));
  // A host may ask for a tab after mount too — a team's row in Activity, a
  // chart's Open team on home — through the same prop, one shot at a time.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const tabClass = (id: WorkspaceTab) => (tab === id ? SEGMENT_ON : SEGMENT_OFF);
  const panelClass = fill ? "flex-1 min-h-0 flex flex-col" : undefined;
  // The pane's height: a fixed cap inside a scrolling page, or the column's
  // own height when the page hands it one — the files are what the tab is
  // for, and a 28rem strip under a 60rem window was the complaint.
  const paneClass = fill ? "flex-1 min-h-[22rem] @3xl:min-h-0" : "max-h-[28rem]";
  const tabButton = (id: WorkspaceTab, glyph: string, label: string, testId: string, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      id={`coding-agent-workspace-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`coding-agent-workspace-pane-${id}`}
      onClick={() => setTab(id)}
      data-testid={testId}
      className={tabClass(id)}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{glyph}</span>
      {label}
      {extra}
    </button>
  );
  return (
    <div className={`mt-3 ${fill ? "flex-1 min-h-0 flex flex-col" : ""}`} data-testid="coding-agent-workspace" data-fill={fill || undefined}>
      <div className={`${SEGMENTED_TRACK} ${activity || team ? "max-w-xl" : "max-w-xs"}`} role="tablist" aria-label={t("codingAgent.workspaceTitle")}>
        {/* Activity first and by default: the teams and the runs of this
            project, live first. The id is the Runs tab's old one, since the
            list it holds is the same list. */}
        {activity && tabButton(
          "activity",
          "history",
          t("codingAgent.activityTab"),
          "coding-agent-workspace-runs",
          activityLive && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" data-testid="coding-agent-workspace-runs-live" />,
        )}
        {tabButton("files", "folder_open", t("codingAgent.filesTab"), "coding-agent-workspace-files")}
        {tabButton("changes", "difference", t("codingAgent.changesTab"), "coding-agent-workspace-changes")}
        {team && tabButton("team", "groups", t("codingAgent.teamTab"), "coding-agent-workspace-team")}
      </div>
      {/* The panes stay mounted: a tree that was opened three folders deep
          would otherwise fold every time the owner glanced at the diff. */}
      {activity && (
        <div role="tabpanel" id="coding-agent-workspace-pane-activity" aria-labelledby="coding-agent-workspace-tab-activity" hidden={tab !== "activity"} className={fill ? "flex-1 min-h-0 overflow-y-auto" : undefined}>
          {activity}
        </div>
      )}
      <div role="tabpanel" id="coding-agent-workspace-pane-files" aria-labelledby="coding-agent-workspace-tab-files" hidden={tab !== "files"} className={panelClass}>
        <FilesPane query={query} directory={directory} filesDirectory={filesDirectory} paneClass={paneClass} fill={fill} />
      </div>
      <div role="tabpanel" id="coding-agent-workspace-pane-changes" aria-labelledby="coding-agent-workspace-tab-changes" hidden={tab !== "changes"} className={panelClass}>
        <ChangesPane query={query} live={live} initialRef={initialRef} active={tab === "changes"} paneClass={paneClass} fill={fill} />
      </div>
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

function FilesPane({ query, directory, filesDirectory, paneClass, fill }: { query: string; directory?: string; filesDirectory?: string; paneClass: string; fill: boolean }) {
  const { t } = useT();
  const [listings, setListings] = useState<Record<string, TreeListing>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const [failed, setFailed] = useState<string | null>(null);
  const [file, setFile] = useState<TreeFile | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [filesBusy, setFilesBusy] = useState(false);
  // Which opening of a file the viewer shows: a read that lands after
  // another file was tapped is dropped rather than drawn over it.
  const opening = useRef(0);

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

  const openFile = async (rel: string) => {
    const mine = ++opening.current;
    setFileBusy(rel);
    try {
      const res = await fetch(`/setup-api/coding-agent/tree?${query}&file=${encodeURIComponent(rel)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { file?: TreeFile; error?: string } | null;
      if (!res.ok || !data?.file) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      if (opening.current !== mine) return;
      setFile(data.file);
      setFailed(null);
    } catch (err) {
      if (opening.current !== mine) return;
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    } finally {
      if (opening.current === mine) setFileBusy(null);
    }
  };

  // The Files app browses from the owner's home; the project folder is
  // named to it as the Files route knows it, then a Files window of its
  // own opens there (a plain `openApp` would only raise the one already up).
  // Editing belongs there: this pane reads.
  const openInFiles = async () => {
    if (!filesDirectory || filesBusy) return;
    setFilesBusy(true);
    try {
      const res = await fetch("/setup-api/files?dir=", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resolve", filePath: filesDirectory }),
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
    <div className={`mt-2 ${CARD_SURFACE} overflow-hidden flex flex-col ${fill ? "flex-1 min-h-0" : ""}`} data-testid="coding-agent-files" data-pane={file ? "file" : "tree"}>
      {/* The folder, as text, and the one way to edit it. */}
      {(directory || filesDirectory) && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-white/[0.06] text-[11px] min-h-[36px]">
          <span className="material-symbols-rounded text-[var(--text-muted)] shrink-0" style={{ fontSize: 14 }} aria-hidden="true">folder</span>
          {directory && (
            <span className="font-mono text-[var(--text-muted)] truncate" title={directory} data-testid="coding-agent-project-path">{directory}</span>
          )}
          {filesDirectory && (
            <button
              type="button"
              onClick={() => void openInFiles()}
              disabled={filesBusy}
              data-testid="coding-agent-open-in-files"
              className={`${PANE_BUTTON} ml-auto`}
              title={t("codingAgent.openInFiles")}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
              {t("codingAgent.openInFiles")}
            </button>
          )}
        </div>
      )}
      <div className={`@3xl:grid @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] ${fill ? "flex-1 min-h-0" : ""}`}>
        {/* One pane at a time under @3xl: the tree gives way to the file it
            opened, and the file's header leads back. */}
        <div className={`${paneClass} overflow-y-auto @3xl:border-r border-white/[0.06] ${file ? "hidden @3xl:block" : ""}`} data-testid="coding-agent-file-tree">
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
                    onClick={() => (isDir ? toggle(path) : void openFile(path))}
                    data-testid={`coding-agent-tree-${path}`}
                    title={path}
                    className={`w-full flex items-center gap-1.5 min-h-[40px] @md:min-h-0 py-1 pr-2 text-left text-[12px] hover:bg-white/[0.05] ${current ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
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
        <div className={`min-w-0 min-h-[8rem] ${paneClass} overflow-auto flex-col ${file ? "flex" : "hidden @3xl:flex"}`} data-testid="coding-agent-file-view">
          {failed && root && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {!file ? (
            <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.pickFile")}</p>
          ) : (
            <>
              <div className="sticky top-0 left-0 z-10 flex items-center gap-2 px-3 py-1 border-b border-white/[0.06] bg-[var(--win-ground)] text-[11px]">
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  aria-label={t("codingAgent.filesBack")}
                  title={t("codingAgent.filesBack")}
                  data-testid="coding-agent-file-back"
                  className={`${PANE_BUTTON} -ml-2 @3xl:hidden`}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">arrow_back</span>
                </button>
                <span className="font-mono text-[var(--text-primary)] truncate">{file.path}</span>
                <span className="text-[var(--text-muted)] shrink-0">{formatSize(file.size)}</span>
                {file.truncated && <span className="text-amber-300 shrink-0">{t("codingAgent.fileTruncated")}</span>}
              </div>
              {file.binary ? (
                <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.binaryFile")}</p>
              ) : (
                // Read-only: no `onChange`, so the editor draws no textarea.
                <CodeEditor value={file.content} language={languageForFile(file.path)} testId="coding-agent-file-editor" className="flex-1" />
              )}
            </>
          )}
        </div>
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
  // Opened with nothing at work and nothing uncommitted, the tab steps to
  // the newest commit by itself — ONCE — because a settled run leaves the
  // tree clean and the work in history, and an empty "Working tree" said
  // nothing. A run's own page names its commit (`initialRef`) instead.
  const stepped = useRef(false);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await fetch(`/setup-api/coding-agent/git?${query}&changes=1${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { changes?: GitChanges; log?: CommitSummary[]; error?: string } | null;
      if (mine !== generation.current) return;
      if (!res.ok || !data?.changes) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      setChanges(data.changes);
      const commits = data.log ?? [];
      setLog(commits);
      setFailed(null);
      if (!ref && !live && !initialRef && !stepped.current && data.changes.available && data.changes.files.length === 0 && commits.length > 0) {
        stepped.current = true;
        setRef(commits[0].sha);
      }
    } catch (err) {
      if (mine !== generation.current) return;
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    }
  }, [query, ref, live, initialRef, t]);

  // Read only once the tab is open: the page's git block is read on every
  // project page, and a second git read for a pane nobody is looking at is
  // three more spawns on a Jetson.
  useEffect(() => { if (active) void load(); }, [active, load]);

  // A run in flight writes as it goes; the list follows while it is on screen
  // — and not while nobody can see the page (visible-interval.ts).
  useEffect(() => {
    if (!live || !active || ref) return;
    return setVisibleInterval(() => { void load(); }, LIVE_POLL_MS);
  }, [live, active, ref, load]);

  // A settled run's commit arrives after the page opened on the working tree.
  useEffect(() => {
    if (initialRef) { setRef(initialRef); setSelected(null); setDiff(null); }
  }, [initialRef]);

  const show = (next: string) => { setRef(next); setSelected(null); setDiff(null); };

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

  // Where the ref sits in the recent log: -1 is the working tree. A commit
  // older than the log (a run's own, past the twenty) can only step back up
  // to the working tree.
  const index = ref === "" ? -1 : log.findIndex((c) => c.sha === ref);
  const current = index >= 0 ? log[index] : null;
  const newer: string | null = ref === "" ? null : index <= 0 ? "" : log[index - 1].sha;
  const older: string | null = ref !== "" && index === -1 ? null : index + 1 < log.length ? log[index + 1].sha : null;
  const label = ref === "" ? t("codingAgent.uncommitted") : current ? `${current.sha.slice(0, 7)} · ${current.subject}` : ref.slice(0, 7);

  const files = changes?.files ?? [];
  return (
    <div className={`mt-2 ${CARD_SURFACE} overflow-hidden flex flex-col ${fill ? "flex-1 min-h-0" : ""}`} data-testid="coding-agent-changes" data-pane={selected ? "diff" : "list"}>
      <div className="flex items-center gap-2 px-3 py-1 border-b border-white/[0.06] text-[11px] flex-wrap min-h-[36px]">
        <span className="material-symbols-rounded text-[var(--text-muted)] shrink-0" style={{ fontSize: 14 }} aria-hidden="true">commit</span>
        <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={label} data-testid="coding-agent-change-label">{label}</span>
        <span className="text-[var(--text-muted)] shrink-0" data-testid="coding-agent-change-totals">
          {changes?.available && files.length > 0 && (
            <>
              {t("codingAgent.filesChanged", { n: files.length })}
              <span className="text-emerald-300"> +{changes.additions}</span>
              <span className="text-red-300"> −{changes.deletions}</span>
            </>
          )}
        </span>
        {/* Newer / Older: the last twenty commits and the working tree, one
            step at a time. Quiet, and off at either end. */}
        {(log.length > 0 || ref !== "") && (
          <span className="flex items-center gap-1 basis-full @md:basis-auto justify-end" data-testid="coding-agent-change-steps">
            <button type="button" onClick={() => newer !== null && show(newer)} disabled={newer === null} data-testid="coding-agent-change-newer" className={PANE_BUTTON}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">chevron_left</span>
              {t("codingAgent.changeNewer")}
            </button>
            <button type="button" onClick={() => older !== null && show(older)} disabled={older === null} data-testid="coding-agent-change-older" className={PANE_BUTTON}>
              {t("codingAgent.changeOlder")}
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">chevron_right</span>
            </button>
          </span>
        )}
      </div>
      <div className={`@3xl:grid @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] ${fill ? "flex-1 min-h-0" : ""}`}>
        <div className={`${paneClass} overflow-y-auto @3xl:border-r border-white/[0.06] ${selected ? "hidden @3xl:block" : ""}`} data-testid="coding-agent-change-list">
          {failed && !changes && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {changes && !changes.available && <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noGitHistory")}</p>}
          {changes?.available && files.length === 0 && <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noChanges")}</p>}
          <ul className="py-1">
            {files.map((f) => <ChangeRow key={f.path} file={f} selected={selected === f.path} onOpen={() => void openDiff(f.path)} />)}
          </ul>
          {changes?.truncated && <p className="px-3 py-1.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.listTruncated")}</p>}
        </div>
        <div className={`min-w-0 min-h-[8rem] ${paneClass} overflow-auto ${selected ? "" : "hidden @3xl:block"}`} data-testid="coding-agent-diff-view">
          {failed && changes && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {!selected ? (
            <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{files.length > 0 ? t("codingAgent.pickDiff") : ""}</p>
          ) : (
            <>
              <div className="sticky top-0 flex items-center gap-2 px-3 py-1 border-b border-white/[0.06] bg-[var(--win-ground)] text-[11px]">
                <button
                  type="button"
                  onClick={() => { setSelected(null); setDiff(null); }}
                  aria-label={t("codingAgent.diffBack")}
                  title={t("codingAgent.diffBack")}
                  data-testid="coding-agent-diff-back"
                  className={`${PANE_BUTTON} -ml-2 @3xl:hidden`}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">arrow_back</span>
                </button>
                <span className="font-mono text-[var(--text-primary)] truncate">{diff?.path ?? selected}</span>
                {diff?.truncated && <span className="text-amber-300 shrink-0">{t("codingAgent.diffTruncated")}</span>}
              </div>
              {diffBusy && !diff ? (
                <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">…</p>
              ) : diff ? (
                diff.binary ? (
                  <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.binaryFile")}</p>
                ) : diff.diff ? (
                  <DiffView text={diff.diff} />
                ) : (
                  <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noChanges")}</p>
                )
              ) : null}
            </>
          )}
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
        className={`w-full flex items-center gap-2 px-3 min-h-[40px] @md:min-h-0 py-1 text-left text-[12px] hover:bg-white/[0.05] ${selected ? "bg-white/[0.08] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
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
