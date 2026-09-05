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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { ChangedFile, ChangeStatus, CommitSummary, FileDiff, GitChanges } from "@/lib/coding-git";
import type { TreeEntry, TreeFile, TreeListing } from "@/lib/coding-project-tree";
import { fileIcon, formatSize, Icon } from "./file-icons";
import { SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";
import { timeAgo } from "./clawkeep-ui";

export type WorkspaceTab = "files" | "changes";

interface Props {
  /** `projectId=<id>` for a code project, `directory=<abs>` for a folder —
   *  the same query the page's git block sends. */
  query: string;
  /** A run is working in the folder: the change list follows it. */
  live: boolean;
  /** The commit to open the Changes tab on — a settled run's own. */
  initialRef?: string | null;
  initialTab?: WorkspaceTab;
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

export default function CodingProjectWorkspace({ query, live, initialRef = null, initialTab = "files" }: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  return (
    <div className="mt-3" data-testid="coding-agent-workspace">
      <div className={`${SEGMENTED_TRACK} max-w-xs`} role="tablist" aria-label={t("codingAgent.workspaceTitle")}>
        <button
          type="button"
          role="tab"
          id="coding-agent-workspace-tab-files"
          aria-selected={tab === "files"}
          aria-controls="coding-agent-workspace-pane-files"
          onClick={() => setTab("files")}
          data-testid="coding-agent-workspace-files"
          className={tab === "files" ? SEGMENT_ON : SEGMENT_OFF}
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
          className={tab === "changes" ? SEGMENT_ON : SEGMENT_OFF}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">difference</span>
          {t("codingAgent.changesTab")}
        </button>
      </div>
      {/* Both panes stay mounted: a tree that was opened three folders deep
          would otherwise fold every time the owner glanced at the diff. */}
      <div role="tabpanel" id="coding-agent-workspace-pane-files" aria-labelledby="coding-agent-workspace-tab-files" hidden={tab !== "files"}>
        <FilesPane query={query} />
      </div>
      <div role="tabpanel" id="coding-agent-workspace-pane-changes" aria-labelledby="coding-agent-workspace-tab-changes" hidden={tab !== "changes"}>
        <ChangesPane query={query} live={live} initialRef={initialRef} active={tab === "changes"} />
      </div>
    </div>
  );
}

// ─── Files ──────────────────────────────────────────────────────────────────

type Node = { path: string; entry: TreeEntry; depth: number };

function FilesPane({ query }: { query: string }) {
  const { t } = useT();
  const [listings, setListings] = useState<Record<string, TreeListing>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const [failed, setFailed] = useState<string | null>(null);
  const [file, setFile] = useState<TreeFile | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);

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
    setFileBusy(rel);
    try {
      const res = await fetch(`/setup-api/coding-agent/tree?${query}&file=${encodeURIComponent(rel)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { file?: TreeFile; error?: string } | null;
      if (!res.ok || !data?.file) throw new Error(data?.error ?? t("codingAgent.workspaceError"));
      setFile(data.file);
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : t("codingAgent.workspaceError"));
    } finally {
      setFileBusy(null);
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
    <div className="mt-2 rounded-xl border border-[var(--border-subtle)] bg-white/[0.02] overflow-hidden @3xl:grid @3xl:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
      <div className="max-h-[28rem] overflow-y-auto border-b @3xl:border-b-0 @3xl:border-r border-[var(--border-subtle)]" data-testid="coding-agent-file-tree">
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
      <div className="min-w-0 min-h-[8rem] max-h-[28rem] overflow-auto" data-testid="coding-agent-file-view">
        {failed && root && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
        {!file ? (
          <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.pickFile")}</p>
        ) : (
          <>
            <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-deep)] text-[11px]">
              <span className="font-mono text-[var(--text-primary)] truncate">{file.path}</span>
              <span className="text-[var(--text-muted)] shrink-0">{formatSize(file.size)}</span>
              {file.truncated && <span className="text-amber-300 shrink-0">{t("codingAgent.fileTruncated")}</span>}
            </div>
            {file.binary ? (
              <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.binaryFile")}</p>
            ) : (
              <NumberedText text={file.content} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Plain text with a line-number gutter; never markup — a run wrote it. */
function NumberedText({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return (
    <pre className="text-[11.5px] leading-[1.45] font-mono text-[var(--text-secondary)] px-0 py-1">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-10 shrink-0 select-none text-right pr-2 text-[var(--text-muted)] opacity-50">{i + 1}</span>
          <span className="whitespace-pre-wrap break-all">{line}</span>
        </div>
      ))}
    </pre>
  );
}

// ─── Changes ────────────────────────────────────────────────────────────────

function ChangesPane({ query, live, initialRef, active }: { query: string; live: boolean; initialRef: string | null; active: boolean }) {
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
    <div className="mt-2 rounded-xl border border-[var(--border-subtle)] bg-white/[0.02] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] text-[11px]">
        <label className="flex items-center gap-1.5 min-w-0">
          <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 14 }} aria-hidden="true">commit</span>
          <select
            value={ref}
            onChange={(e) => { setRef(e.target.value); setSelected(null); setDiff(null); }}
            aria-label={t("codingAgent.changePicker")}
            data-testid="coding-agent-change-picker"
            className="bg-transparent text-[var(--text-primary)] text-[11px] max-w-[20rem] truncate outline-none"
          >
            <option value="" className="bg-[var(--bg-deep)]">{t("codingAgent.uncommitted")}</option>
            {log.map((c) => (
              <option key={c.sha} value={c.sha} className="bg-[var(--bg-deep)]">
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
      <div className="@3xl:grid @3xl:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
        <div className="max-h-[28rem] overflow-y-auto border-b @3xl:border-b-0 @3xl:border-r border-[var(--border-subtle)]" data-testid="coding-agent-change-list">
          {failed && !changes && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {changes && !changes.available && <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noGitHistory")}</p>}
          {changes?.available && files.length === 0 && <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{t("codingAgent.noChanges")}</p>}
          <ul className="py-1">
            {files.map((f) => <ChangeRow key={f.path} file={f} selected={selected === f.path} onOpen={() => void openDiff(f.path)} />)}
          </ul>
          {changes?.truncated && <p className="px-3 py-1.5 text-[11px] text-[var(--text-muted)]">{t("codingAgent.listTruncated")}</p>}
        </div>
        <div className="min-w-0 min-h-[8rem] max-h-[28rem] overflow-auto" data-testid="coding-agent-diff-view">
          {failed && changes && <p className="px-3 py-2 text-[11px] text-red-300">{failed}</p>}
          {!selected ? (
            <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{files.length > 0 ? t("codingAgent.pickDiff") : ""}</p>
          ) : diffBusy && !diff ? (
            <p className="px-3 py-3 text-[11px] text-[var(--text-muted)]">…</p>
          ) : diff ? (
            <>
              <div className="sticky top-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-deep)] text-[11px]">
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
