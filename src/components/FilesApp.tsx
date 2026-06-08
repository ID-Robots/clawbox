"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useT } from "@/lib/i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number | null;
  modified: string;
  // Set only on recursive search results: path relative to the files root.
  // When absent, the entry lives in the currently-loaded directory.
  path?: string;
}

type ViewerKind = "text" | "image" | "pdf" | "video" | "audio" | "toobig" | "binary";

type ViewMode = "grid" | "list";

interface DialogState {
  type: "rename" | "mkdir" | "delete" | null;
  entry?: FileEntry;
  value?: string;
}

type ContextMenuState = {
  entry: FileEntry;
  x: number;
  y: number;
} | null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAVORITES = [
  { labelKey: "files.home", icon: "home", path: "" },
  { labelKey: "files.documents", icon: "description", path: "Documents" },
  { labelKey: "files.downloads", icon: "download", path: "Downloads" },
  { labelKey: "files.desktop", icon: "desktop_windows", path: "Desktop" },
];

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot !== -1 ? name.slice(dot + 1).toLowerCase() : "";
}

function downloadViaLink(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

// Parent directory of a root-relative search-result path ("a/b/c.txt" -> "a/b").
function parentDirOf(p?: string): string {
  if (!p) return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// Stable identity for selection + React keys. In a folder listing the name is
// unique; in recursive search results two files can share a name across
// directories, so the full relative path is the unique key.
function entryId(e: FileEntry): string {
  return e.path ?? e.name;
}

// ─── File viewer kind detection ────────────────────────────────────────────────

// Anything bigger than this won't open in the in-browser text editor — it would
// be sluggish and risks the gateway buffering a huge string. Such files fall
// back to a download prompt.
const TEXT_MAX = 2 * 1024 * 1024;

// The file-serving route reads the whole file into memory (no Range streaming),
// so cap inline media too — pointing a <video>/<img> at a multi-hundred-MB file
// would buffer it all into the Jetson's RAM. Above this, offer a download.
const MEDIA_MAX = 50 * 1024 * 1024;

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif"]);
const PDF_EXT = new Set(["pdf"]);
const VIDEO_EXT = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"]);

function resolveViewerKind(name: string, size: number | null): ViewerKind {
  const ext = fileExtension(name);
  const media: ViewerKind | null = IMAGE_EXT.has(ext) ? "image"
    : PDF_EXT.has(ext) ? "pdf"
    : VIDEO_EXT.has(ext) ? "video"
    : AUDIO_EXT.has(ext) ? "audio"
    : null;
  if (media) return size != null && size > MEDIA_MAX ? "toobig" : media;
  if (size != null && size > TEXT_MAX) return "toobig";
  // Known-text, no-extension config/scripts, and unknown-but-small files all
  // attempt the text editor; a binary sniff after fetch reclassifies if needed.
  return "text";
}

// Cheap heuristic: a NUL byte or a high ratio of U+FFFD replacement chars (from
// decoding non-UTF-8 bytes as text) means this isn't editable text.
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  let replacement = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c === 0xfffd) replacement++;
  }
  return replacement > sample.length * 0.02;
}

function fileIcon(name: string, type: "file" | "directory"): { icon: string; color: string } {
  if (type === "directory") return { icon: "folder", color: "#f97316" };
  const ext = fileExtension(name);
  const map: Record<string, { icon: string; color: string }> = {
    pdf: { icon: "picture_as_pdf", color: "#ef4444" },
    doc: { icon: "article", color: "#3b82f6" },
    docx: { icon: "article", color: "#3b82f6" },
    xls: { icon: "table_chart", color: "#22c55e" },
    xlsx: { icon: "table_chart", color: "#22c55e" },
    ppt: { icon: "slideshow", color: "#f59e0b" },
    pptx: { icon: "slideshow", color: "#f59e0b" },
    txt: { icon: "text_snippet", color: "#9ca3af" },
    md: { icon: "text_snippet", color: "#9ca3af" },
    csv: { icon: "table_chart", color: "#22c55e" },
    jpg: { icon: "image", color: "#a855f7" },
    jpeg: { icon: "image", color: "#a855f7" },
    png: { icon: "image", color: "#a855f7" },
    gif: { icon: "image", color: "#a855f7" },
    svg: { icon: "image", color: "#a855f7" },
    webp: { icon: "image", color: "#a855f7" },
    mp4: { icon: "movie", color: "#ec4899" },
    mov: { icon: "movie", color: "#ec4899" },
    avi: { icon: "movie", color: "#ec4899" },
    mkv: { icon: "movie", color: "#ec4899" },
    mp3: { icon: "music_note", color: "#06b6d4" },
    wav: { icon: "music_note", color: "#06b6d4" },
    flac: { icon: "music_note", color: "#06b6d4" },
    zip: { icon: "folder_zip", color: "#f59e0b" },
    tar: { icon: "folder_zip", color: "#f59e0b" },
    gz: { icon: "folder_zip", color: "#f59e0b" },
    rar: { icon: "folder_zip", color: "#f59e0b" },
    js: { icon: "code", color: "#facc15" },
    ts: { icon: "code", color: "#3b82f6" },
    py: { icon: "code", color: "#22c55e" },
    json: { icon: "data_object", color: "#f59e0b" },
    yaml: { icon: "settings", color: "#9ca3af" },
    yml: { icon: "settings", color: "#9ca3af" },
    sh: { icon: "terminal", color: "#22c55e" },
    bash: { icon: "terminal", color: "#22c55e" },
  };
  return map[ext] ?? { icon: "draft", color: "#6b7280" };
}

function Icon({ name, size = 20, color, className = "", ariaLabel }: { name: string; size?: number; color?: string; className?: string; ariaLabel?: string }) {
  return (
    <span
      className={`material-symbols-rounded ${className}`}
      style={{ fontSize: size, color, lineHeight: 1 }}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
    >
      {name}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FilesApp() {
  const { t } = useT();
  const [currentPath, setCurrentPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  // Hidden by default — matches every desktop file manager. Persisted across
  // window reopens so the user's choice sticks. Reading lazily inside
  // useState's initializer guards against SSR (no `window` until mount).
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("clawbox.files.showHidden") === "1";
  });

  const toggleShowHidden = useCallback(() => {
    setShowHidden((v) => {
      const next = !v;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("clawbox.files.showHidden", next ? "1" : "0");
      }
      return next;
    });
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: null });
  const [dragOver, setDragOver] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" ? window.innerWidth >= 768 : true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  // Search + viewer state
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [viewer, setViewer] = useState<{ relPath: string; entry: FileEntry } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; entry: FileEntry } | null>(null);

  // ─── Load directory ────────────────────────────────────────────────────────

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSelected(null);
    // Recursive results are scoped to one directory — drop them when we move
    // to another folder (the typed filter in `query` is kept and re-applies to
    // the new listing). navigateTo also closes the search bar for result dirs.
    setRecursive(false);
    setSearchResults([]);
    setSearchTruncated(false);
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      const sorted = [...(data.files as FileEntry[])].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sorted);
      setCurrentPath(dir);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(""); }, [load]);

  // POSIX hidden files start with a dot. We filter client-side because the
  // server returns the full directory; this lets the toggle flip instantly
  // without a re-fetch.
  const visibleFiles = showHidden ? files : files.filter((f) => !f.name.startsWith("."));

  // ─── Search ──────────────────────────────────────────────────────────────────

  const entryRelPath = useCallback(
    (entry: FileEntry) => entry.path ?? (currentPath ? `${currentPath}/${entry.name}` : entry.name),
    [currentPath],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setRecursive(false);
    setSearchResults([]);
    setSearchTruncated(false);
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setRecursive(true);
    try {
      const res = await fetch(
        `/setup-api/files?dir=${encodeURIComponent(currentPath)}&search=${encodeURIComponent(term)}&hidden=${showHidden ? "1" : "0"}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      const sorted = [...(data.files as FileEntry[])].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return (a.path ?? a.name).localeCompare(b.path ?? b.name);
      });
      setSearchResults(sorted);
      setSearchTruncated(Boolean(data.truncated));
    } catch (e) {
      setSearchResults([]);
      setStatusMsg(e instanceof Error ? e.message : "Search failed");
      setTimeout(() => setStatusMsg(null), 3000);
    } finally {
      setSearching(false);
    }
  }, [currentPath, showHidden]);

  // Re-render whatever is on screen after a mutation (rename/delete/save):
  // re-run the search if results are showing, otherwise reload the folder.
  const refreshView = useCallback(() => {
    if (recursive && query.trim()) runSearch(query);
    else load(currentPath);
  }, [recursive, query, runSearch, load, currentPath]);

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  // The list to display: recursive results when present, else a live
  // case-insensitive filter of the current folder, else the full folder.
  const q = query.trim().toLowerCase();
  const displayFiles = recursive
    ? searchResults
    : q
      ? visibleFiles.filter((f) => f.name.toLowerCase().includes(q))
      : visibleFiles;
  const searchActive = recursive || q.length > 0;

  // ─── Breadcrumbs ────────────────────────────────────────────────────────────

  const breadcrumbs = [t("files.home"), ...currentPath.split("/").filter(Boolean)];

  const navigateBreadcrumb = (idx: number) => {
    if (idx === 0) { load(""); return; }
    const parts = currentPath.split("/").filter(Boolean).slice(0, idx);
    load(parts.join("/"));
  };

  // ─── Navigation ────────────────────────────────────────────────────────────

  // Open: directories navigate (search results jump to their real location);
  // files open in the in-window viewer/editor.
  const navigateTo = (entry: FileEntry) => {
    if (entry.type === "directory") {
      const next = entryRelPath(entry);
      if (recursive) closeSearch();
      load(next);
    } else {
      setViewer({ relPath: entryRelPath(entry), entry });
    }
  };

  // ─── Download ──────────────────────────────────────────────────────────────

  const downloadFile = (entry: FileEntry) => {
    const url = `/setup-api/files/${entryRelPath(entry).split("/").map(encodeURIComponent).join("/")}`;
    downloadViaLink(url, entry.name);
  };

  // ─── Upload ────────────────────────────────────────────────────────────────

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const total = fileList.length;
    const totalSize = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);

    // Check available disk space
    try {
      const checkRes = await fetch(`/setup-api/files?dir=${encodeURIComponent(currentPath)}`);
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.availableSpace && totalSize > checkData.availableSpace) {
          setStatusMsg(`Not enough disk space. Need ${formatSize(totalSize)}, only ${formatSize(checkData.availableSpace)} available.`);
          setTimeout(() => setStatusMsg(null), 5000);
          return;
        }
      }
    } catch { /* proceed anyway */ }

    let ok = 0;
    for (let i = 0; i < total; i++) {
      const file = fileList[i];
      setStatusMsg(`Uploading ${file.name} (${i + 1}/${total})...`);
      try {
        const res = await fetch(
          `/setup-api/files?dir=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(file.name)}`,
          { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file }
        );
        if (res.ok) {
          ok++;
        } else {
          const data = await res.json().catch(() => ({}));
          if (data.error) {
            setStatusMsg(data.error);
            setTimeout(() => setStatusMsg(null), 5000);
            load(currentPath);
            return;
          }
        }
      } catch { /* ignore */ }
    }
    setStatusMsg(`Uploaded ${ok}/${total} file(s)`);
    setTimeout(() => setStatusMsg(null), 2500);
    load(currentPath);
  };

  // ─── Drag & Drop ──────────────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  };

  // ─── Create Folder ────────────────────────────────────────────────────────

  const createFolder = async (name: string) => {
    const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(currentPath)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mkdir", name }),
    });
    const data = await res.json();
    if (!res.ok) { setStatusMsg(`Error: ${data.error}`); return; }
    setStatusMsg("Folder created");
    setTimeout(() => setStatusMsg(null), 2000);
    load(currentPath);
  };

  // ─── Rename ───────────────────────────────────────────────────────────────

  const renameEntry = async (entry: FileEntry, newName: string) => {
    const url = `/setup-api/files/${entryRelPath(entry).split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName }),
    });
    const data = await res.json();
    if (!res.ok) { setStatusMsg(`Error: ${data.error}`); return; }
    setStatusMsg("Renamed");
    setTimeout(() => setStatusMsg(null), 2000);
    refreshView();
  };

  // ─── Delete ───────────────────────────────────────────────────────────────

  const deleteEntry = async (entry: FileEntry) => {
    const url = `/setup-api/files/${entryRelPath(entry).split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) { setStatusMsg(`Error: ${data.error}`); return; }
    setStatusMsg("Deleted");
    setTimeout(() => setStatusMsg(null), 2000);
    refreshView();
  };

  // ─── Dialog submit ────────────────────────────────────────────────────────

  const handleDialogSubmit = () => {
    if (dialog.type === "mkdir" && dialog.value?.trim()) {
      createFolder(dialog.value.trim());
    } else if (dialog.type === "rename" && dialog.entry && dialog.value?.trim()) {
      renameEntry(dialog.entry, dialog.value.trim());
    } else if (dialog.type === "delete" && dialog.entry) {
      deleteEntry(dialog.entry);
    }
    setDialog({ type: null });
  };

  // ─── Context menu ──────────────────────────────────────────────────────────

  const openContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(entryId(entry));
    // Clamp position so menu doesn't overflow viewport
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    setContextMenu({ entry, x, y });
  };

  const handleLongPressStart = (e: React.TouchEvent, entry: FileEntry) => {
    const touch = e.touches[0];
    const x = Math.min(touch.clientX, window.innerWidth - 180);
    const y = Math.min(touch.clientY, window.innerHeight - 200);
    longPressRef.current = {
      entry,
      timer: setTimeout(() => {
        setSelected(entryId(entry));
        setContextMenu({ entry, x, y });
        longPressRef.current = null;
      }, 500),
    };
  };

  const handleLongPressEnd = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  const closeContextMenu = () => setContextMenu(null);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full overflow-hidden relative bg-[var(--bg-deep)] text-[var(--text-primary)] font-body"
      data-testid="files-app"
      onClick={closeContextMenu}
    >

      {/* ── Sidebar ── */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-[5] bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="flex flex-col py-4 overflow-y-auto absolute md:relative z-[6] h-full w-[200px] shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)]">
            <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
              {t("files.favorites")}
            </div>
            {FAVORITES.map((fav) => {
              const active = currentPath === fav.path;
              return (
                <button
                  key={fav.path}
                  onClick={() => { load(fav.path); if (window.innerWidth < 768) setSidebarOpen(false); }}
                  className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left border-l-2 ${
                    active
                      ? "bg-white/[0.08] text-[var(--text-primary)] border-[var(--coral-bright)]"
                      : "text-[var(--text-secondary)] border-transparent hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Icon name={fav.icon} size={18} color={active ? "var(--coral-bright)" : "var(--text-muted)"} />
                  <span>{t(fav.labelKey)}</span>
                </button>
              );
            })}

            <div className="mt-auto px-4 pt-4">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] border border-[var(--coral-bright)]/30 hover:bg-[var(--coral-bright)]/25 cursor-pointer"
              >
                <Icon name="upload" size={16} />
                {t("files.upload")}
              </button>
            </div>
          </aside>
        </>
      )}

      {/* ── Main area ── */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-1.5 px-3 py-2 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <button
            onClick={() => setSidebarOpen(p => !p)}
            className="p-1.5 rounded-md transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] md:hidden cursor-pointer"
            title="Favorites"
          >
            <Icon name="menu" size={18} />
          </button>
          <button
            onClick={() => {
              if (!currentPath) return;
              const parts = currentPath.split("/").filter(Boolean);
              parts.pop();
              load(parts.join("/"));
            }}
            disabled={!currentPath}
            className="p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-default text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06]"
            title={t("files.goUp")}
          >
            <Icon name="chevron_left" size={18} />
          </button>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 flex-1 text-sm overflow-hidden">
            {breadcrumbs.map((crumb, idx) => (
              <span key={idx} className="flex items-center gap-1 shrink-0">
                {idx > 0 && <Icon name="chevron_right" size={14} color="var(--text-muted)" />}
                <button
                  onClick={() => navigateBreadcrumb(idx)}
                  className={`hover:underline truncate max-w-[120px] cursor-pointer ${
                    idx === breadcrumbs.length - 1 ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"
                  }`}
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              className={`p-1.5 rounded-md transition-colors hover:bg-white/[0.06] cursor-pointer ${
                searchOpen || searchActive
                  ? "text-[var(--coral-bright)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title={t("files.search")}
              aria-pressed={searchOpen}
            >
              <Icon name="search" size={18} />
            </button>
            <button
              onClick={() => setDialog({ type: "mkdir", value: "" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.1] cursor-pointer"
              title={t("files.newFolder")}
            >
              <Icon name="create_new_folder" size={16} />
              <span className="hidden sm:inline">{t("files.newFolder")}</span>
            </button>
            <button
              onClick={() => load(currentPath)}
              className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title={t("files.refresh")}
            >
              <Icon name="refresh" size={18} />
            </button>
            <button
              onClick={toggleShowHidden}
              className={`p-1.5 rounded-md transition-colors hover:bg-white/[0.06] cursor-pointer ${
                showHidden
                  ? "text-[var(--coral-bright)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
              title={showHidden ? t("files.hideHiddenFiles") : t("files.showHiddenFiles")}
              aria-pressed={showHidden}
            >
              <Icon name={showHidden ? "visibility" : "visibility_off"} size={18} />
            </button>
            <button
              onClick={() => setViewMode(v => v === "grid" ? "list" : "grid")}
              className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title={viewMode === "grid" ? t("files.switchToList") : t("files.switchToGrid")}
            >
              <Icon name={viewMode === "grid" ? "view_list" : "grid_view"} size={18} />
            </button>
          </div>
        </div>

        {/* ── Search bar ── */}
        {searchOpen && (
          <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            <Icon name="search" size={16} className="text-[var(--text-muted)] shrink-0" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setRecursive(false); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (query.trim()) runSearch(query); }
                else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
              }}
              placeholder={t("files.searchPlaceholder")}
              className="flex-1 min-w-0 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-[var(--text-muted)]"
            />
            {query.trim() && !recursive && (
              <button
                onClick={() => runSearch(query)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs whitespace-nowrap transition-colors bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 cursor-pointer shrink-0"
                title={t("files.searchEverywhere")}
              >
                <Icon name="travel_explore" size={14} />
                <span className="hidden sm:inline">{t("files.searchEverywhere")}</span>
              </button>
            )}
            {searching && <Icon name="progress_activity" size={16} className="animate-spin text-[var(--text-muted)] shrink-0" />}
            <button
              onClick={closeSearch}
              className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer shrink-0"
              title={t("files.clearSearch")}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}

        {/* ── File Area ── */}
        <div
          ref={dropZoneRef}
          className={`flex-1 overflow-y-auto relative transition-colors ${dragOver ? "bg-[var(--coral-bright)]/5" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div className="absolute inset-2 z-20 flex items-center justify-center pointer-events-none rounded-xl border-2 border-dashed border-[var(--coral-bright)]/50">
              <div className="text-center text-[var(--coral-bright)]">
                <Icon name="upload_file" size={48} className="mb-2" />
                <div className="text-sm font-medium">{t("files.dropToUpload")}</div>
              </div>
            </div>
          )}

          {recursive && !searching && displayFiles.length > 0 && (
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-xs backdrop-blur bg-[var(--bg-surface)]/90 border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
              <Icon name="search" size={13} />
              <span className="truncate">{t("files.searchResultsFor", { query: query.trim() })}</span>
              <span className="opacity-70 shrink-0">· {displayFiles.length}</span>
              {searchTruncated && (
                <span className="opacity-70 shrink-0">· {t("files.searchTruncated", { count: displayFiles.length })}</span>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              <Icon name="progress_activity" size={24} className="animate-spin mr-2" />
              {t("files.loading")}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full flex-col gap-2 text-red-400">
              <Icon name="error" size={40} />
              <span className="text-sm">{error}</span>
              <button onClick={() => load(currentPath)} className="text-xs underline mt-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">{t("files.retry")}</button>
            </div>
          ) : displayFiles.length === 0 ? (
            searchActive ? (
              <div className="flex items-center justify-center h-full flex-col gap-2 text-[var(--text-muted)]">
                <Icon name="search_off" size={56} color="var(--border-subtle)" />
                <span className="text-sm">
                  {searching ? t("files.searching") : t("files.searchNoResults", { query: query.trim() })}
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full flex-col gap-2 text-[var(--text-muted)]">
                <Icon name="folder_open" size={56} color="var(--border-subtle)" />
                <span className="text-sm">
                  {files.length === 0 ? t("files.emptyFolder") : t("files.hiddenAllItems")}
                </span>
                <span className="text-xs">
                  {files.length === 0 ? t("files.dropOrUpload") : t("files.hiddenToggleEye")}
                </span>
              </div>
            )
          ) : viewMode === "grid" ? (
            <GridView
              files={displayFiles}
              showLocation={recursive}
              selected={selected}
              onSelect={setSelected}
              onOpen={navigateTo}
              onContextMenu={openContextMenu}
              onLongPressStart={handleLongPressStart}
              onLongPressEnd={handleLongPressEnd}
            />
          ) : (
            <ListView
              files={displayFiles}
              showLocation={recursive}
              selected={selected}
              onSelect={setSelected}
              onOpen={navigateTo}
              onContextMenu={openContextMenu}
              onLongPressStart={handleLongPressStart}
              onLongPressEnd={handleLongPressEnd}
            />
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="px-4 py-1.5 text-xs flex items-center justify-between shrink-0 border-t border-[var(--border-subtle)] text-[var(--text-muted)]">
          <span>
            {statusMsg ?? (searchActive
              ? `${displayFiles.length} result${displayFiles.length !== 1 ? "s" : ""}`
              : `${visibleFiles.length} item${visibleFiles.length !== 1 ? "s" : ""}`)}
            {!searchActive && !showHidden && files.length > visibleFiles.length && (
              <span className="opacity-60"> · {files.length - visibleFiles.length} hidden</span>
            )}
          </span>
          {currentPath && <span className="opacity-60">~/{currentPath}</span>}
        </div>
      </div>

      {/* ── Hidden file input ── */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => uploadFiles(e.target.files)}
      />

      {/* ── Context Menu ── */}
      {contextMenu && (
        <ContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          onOpen={() => { closeContextMenu(); navigateTo(contextMenu.entry); }}
          onDownload={() => { closeContextMenu(); downloadFile(contextMenu.entry); }}
          onRename={() => { closeContextMenu(); setDialog({ type: "rename", entry: contextMenu.entry, value: contextMenu.entry.name }); }}
          onDelete={() => { closeContextMenu(); setDialog({ type: "delete", entry: contextMenu.entry }); }}
          onClose={closeContextMenu}
        />
      )}

      {/* ── File viewer / editor ── */}
      {viewer && (
        <FileViewer
          relPath={viewer.relPath}
          entry={viewer.entry}
          onClose={() => setViewer(null)}
          onSaved={refreshView}
        />
      )}

      {/* ── Dialogs ── */}
      {dialog.type && (
        <DialogOverlay
          dialog={dialog}
          onChange={(value) => setDialog(d => ({ ...d, value }))}
          onCancel={() => setDialog({ type: null })}
          onSubmit={handleDialogSubmit}
        />
      )}
    </div>
  );
}

// ─── Grid View ────────────────────────────────────────────────────────────────

function GridView({ files, showLocation, selected, onSelect, onOpen, onContextMenu, onLongPressStart, onLongPressEnd }: {
  files: FileEntry[];
  showLocation?: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onLongPressStart: (e: React.TouchEvent, entry: FileEntry) => void;
  onLongPressEnd: () => void;
}) {
  return (
    <div className="p-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}
      onClick={() => onSelect(null)}>
      {files.map((entry) => {
        const id = entryId(entry);
        const isSelected = selected === id;
        const fi = fileIcon(entry.name, entry.type);
        return (
          <div
            key={id}
            title={showLocation && entry.path ? entry.path : entry.name}
            className={`flex flex-col items-center gap-1.5 p-3 rounded-xl cursor-pointer transition-all select-none ${
              isSelected
                ? "bg-[var(--coral-bright)]/10 border border-[var(--coral-bright)]/40"
                : "border border-transparent hover:bg-white/[0.04]"
            }`}
            onClick={(e) => { e.stopPropagation(); onSelect(id); }}
            onDoubleClick={() => onOpen(entry)}
            onContextMenu={(e) => onContextMenu(e, entry)}
            onTouchStart={(e) => onLongPressStart(e, entry)}
            onTouchEnd={onLongPressEnd}
            onTouchMove={onLongPressEnd}
          >
            <Icon name={fi.icon} size={36} color={fi.color} />
            <span className="text-xs text-center line-clamp-2 w-full leading-tight text-[var(--text-primary)]" style={{ wordBreak: "break-word" }}>
              {entry.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

function ListView({ files, showLocation, selected, onSelect, onOpen, onContextMenu, onLongPressStart, onLongPressEnd }: {
  files: FileEntry[];
  showLocation?: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onLongPressStart: (e: React.TouchEvent, entry: FileEntry) => void;
  onLongPressEnd: () => void;
}) {
  const { t } = useT();
  return (
    <div className="w-full" onClick={() => onSelect(null)}>
      {/* Header */}
      <div className="grid px-4 py-2 text-xs font-medium sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-deep)] text-[var(--text-muted)]"
        style={{ gridTemplateColumns: "1fr 80px 160px" }}>
        <span>{t("files.name")}</span>
        <span className="text-right">{t("files.size")}</span>
        <span className="text-right">{t("files.modified")}</span>
      </div>
      {files.map((entry) => {
        const id = entryId(entry);
        const isSelected = selected === id;
        const fi = fileIcon(entry.name, entry.type);
        const location = parentDirOf(entry.path);
        return (
          <div
            key={id}
            className={`grid px-4 py-2 items-center cursor-pointer transition-colors border-b border-white/[0.03] select-none ${
              isSelected ? "bg-[var(--coral-bright)]/10" : "hover:bg-white/[0.03]"
            }`}
            style={{ gridTemplateColumns: "1fr 80px 160px" }}
            onClick={(e) => { e.stopPropagation(); onSelect(id); }}
            onDoubleClick={() => onOpen(entry)}
            onContextMenu={(e) => onContextMenu(e, entry)}
            onTouchStart={(e) => onLongPressStart(e, entry)}
            onTouchEnd={onLongPressEnd}
            onTouchMove={onLongPressEnd}
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <Icon name={fi.icon} size={20} color={fi.color} />
              <span className="flex flex-col min-w-0">
                <span className="truncate text-sm text-[var(--text-primary)]">{entry.name}</span>
                {showLocation && (
                  <span className="truncate text-[11px] text-[var(--text-muted)] leading-tight">
                    {location ? `~/${location}` : t("files.home")}
                  </span>
                )}
              </span>
            </span>
            <span className="text-right text-xs text-[var(--text-muted)]">{formatSize(entry.size)}</span>
            <span className="text-right text-xs text-[var(--text-muted)]">{formatDate(entry.modified)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Context Menu ────────────────────────────────────────────────────────────

function ContextMenu({ entry, x, y, onOpen, onDownload, onRename, onDelete, onClose }: {
  entry: FileEntry;
  x: number;
  y: number;
  onOpen: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    el.focus();
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`;
    }
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`;
    }
  }, [x, y]);

  const { t } = useT();
  const items: { icon: string; label: string; onClick: () => void; danger?: boolean; color?: string }[] = [];

  if (entry.type === "directory") {
    items.push({ icon: "folder_open", label: t("files.open"), onClick: onOpen });
  } else {
    items.push({ icon: "open_in_new", label: t("files.open"), onClick: onOpen });
    items.push({ icon: "download", label: t("files.download"), onClick: onDownload });
  }
  items.push({ icon: "edit", label: t("files.rename"), onClick: onRename });
  items.push({ icon: "delete", label: t("files.delete"), onClick: onDelete, danger: true });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((i) => (i + 1) % items.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        items[focusedIndex].onClick();
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${entry.name}`}
      tabIndex={-1}
      className="fixed z-50 min-w-[160px] py-1.5 rounded-xl shadow-2xl border border-[var(--border-subtle)] overflow-hidden outline-none"
      style={{ left: x, top: y, background: "var(--bg-elevated)", backdropFilter: "blur(16px)" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {/* File info header */}
      <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center gap-2">
        <Icon name={fileIcon(entry.name, entry.type).icon} size={16} color={fileIcon(entry.name, entry.type).color} />
        <span className="text-xs text-[var(--text-secondary)] truncate max-w-[120px]">{entry.name}</span>
      </div>
      {items.map((item, i) => (
        <button
          key={item.label}
          role="menuitem"
          tabIndex={i === focusedIndex ? 0 : -1}
          onClick={item.onClick}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-left cursor-pointer ${
            i === focusedIndex ? "bg-white/[0.08]" : ""
          } ${
            item.danger
              ? "text-red-400 hover:bg-red-500/10"
              : "text-[var(--text-primary)] hover:bg-white/[0.06]"
          }`}
        >
          <Icon name={item.icon} size={18} color={item.danger ? "#f87171" : item.color ?? "var(--text-muted)"} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ─── Dialog Overlay ───────────────────────────────────────────────────────────

function DialogOverlay({ dialog, onChange, onCancel, onSubmit }: {
  dialog: DialogState;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dialog.type !== "delete") inputRef.current?.select(); }, [dialog.type]);

  const isDelete = dialog.type === "delete";
  const title = dialog.type === "mkdir" ? t("files.newFolderTitle")
    : dialog.type === "rename" ? t("files.renameTitle")
    : `Delete "${dialog.entry?.name}"?`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}>
      <div
        className="card-surface rounded-2xl p-6 w-80 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-4 text-[var(--text-primary)] flex items-center gap-2">
          <Icon
            name={isDelete ? "delete" : dialog.type === "mkdir" ? "create_new_folder" : "edit"}
            size={20}
            color={isDelete ? "#ef4444" : "var(--coral-bright)"}
          />
          {title}
        </h3>
        {isDelete ? (
          <p className="text-sm mb-5 text-[var(--text-secondary)]">
            This action cannot be undone. {dialog.entry?.type === "directory" ? t("files.deleteConfirm") : ""}
          </p>
        ) : (
          <input
            ref={inputRef}
            autoFocus
            value={dialog.value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onCancel(); }}
            className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500 mb-5"
            placeholder={dialog.type === "mkdir" ? t("files.folderName") : t("files.newName")}
          />
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
          >
            {t("cancel")}
          </button>
          <button
            onClick={onSubmit}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer text-white ${
              isDelete
                ? "bg-red-600 hover:bg-red-500"
                : "btn-gradient hover:opacity-90"
            }`}
          >
            {isDelete ? t("files.delete") : t("files.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── File Viewer / Editor ───────────────────────────────────────────────────────

// Fills the Files window (absolute inset-0, not a full-screen fixed overlay) so
// it stays inside the window frame. Text/code is editable and saved back via the
// streaming PUT; images/pdf/audio/video preview inline; anything binary or too
// large to edit falls back to a download prompt.
function FileViewer({ relPath, entry, onClose, onSaved }: {
  relPath: string;
  entry: FileEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const initialKind = resolveViewerKind(entry.name, entry.size);
  const [kind, setKind] = useState<ViewerKind>(initialKind);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(initialKind === "text");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const url = `/setup-api/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
  const dirty = kind === "text" && content !== original;

  // Fetch text content; a binary sniff downgrades to the non-editable view.
  useEffect(() => {
    if (initialKind !== "text") return;
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        if (looksBinary(text)) {
          setKind("binary");
        } else {
          setContent(text);
          setOriginal(text);
        }
      })
      .catch(() => { if (!cancelled) setError(t("files.loadError")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Non-text kinds have no autofocusing textarea — focus the container so the
  // Escape-to-close shortcut works.
  useEffect(() => {
    if (initialKind !== "text") rootRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const slash = relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : relPath.slice(0, slash);
    const fname = slash === -1 ? relPath : relPath.slice(slash + 1);
    try {
      const res = await fetch(
        `/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(fname)}`,
        { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: content },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t("files.saveError"));
      }
      setOriginal(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("files.saveError"));
    } finally {
      setSaving(false);
    }
  }, [content, relPath, onSaved, t]);

  const attemptClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [dirty, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the discard confirmation is up, keep keys scoped to it — Escape
    // dismisses it, and nothing else leaks through to the editor underneath.
    if (confirmDiscard) {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmDiscard(false);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty) save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      attemptClose();
    }
  };

  const fi = fileIcon(entry.name, entry.type);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex flex-col bg-[var(--bg-deep)] outline-none"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <Icon name={fi.icon} size={18} color={fi.color} />
        <span className="text-sm font-medium truncate flex-1 text-[var(--text-primary)]" title={relPath}>{entry.name}</span>
        {kind === "text" && (dirty
          ? <span className="text-[11px] text-[var(--text-muted)]" title={t("files.unsavedChanges")}>●</span>
          : saved ? <span className="text-[11px] text-green-400">{t("files.saved")}</span> : null)}
        {kind === "text" && (
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-default bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 cursor-pointer"
            title={t("files.save")}
          >
            <Icon name={saving ? "progress_activity" : "save"} size={16} className={saving ? "animate-spin" : ""} />
            <span className="hidden sm:inline">{t("files.save")}</span>
          </button>
        )}
        <button
          onClick={() => downloadViaLink(url, entry.name)}
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
          title={t("files.download")}
        >
          <Icon name="download" size={18} />
        </button>
        <button
          onClick={attemptClose}
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
          title={t("files.close")}
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto relative">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
            <Icon name="progress_activity" size={24} className="animate-spin mr-2" />{t("files.loading")}
          </div>
        ) : error ? (
          <ViewerMessage icon="error" text={error} url={url} name={entry.name} color="#f87171" />
        ) : kind === "text" ? (
          <textarea
            autoFocus
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="w-full h-full resize-none bg-[var(--bg-deep)] text-[var(--text-primary)] font-mono text-[13px] leading-relaxed p-4 outline-none"
            style={{ tabSize: 2 }}
          />
        ) : kind === "image" ? (
          <div className="flex items-center justify-center h-full p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={entry.name} className="max-w-full max-h-full object-contain" />
          </div>
        ) : kind === "pdf" ? (
          <iframe src={url} title={entry.name} className="w-full h-full border-0 bg-white" />
        ) : kind === "video" ? (
          <div className="flex items-center justify-center h-full p-4 bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={url} controls className="max-w-full max-h-full" />
          </div>
        ) : kind === "audio" ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
            <Icon name="music_note" size={64} color="#06b6d4" />
            <span className="text-sm text-[var(--text-secondary)] truncate max-w-full">{entry.name}</span>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={url} controls />
          </div>
        ) : kind === "toobig" ? (
          <ViewerMessage icon="visibility_off" text={t("files.fileTooLarge")} url={url} name={entry.name} />
        ) : (
          <ViewerMessage icon="draft" text={t("files.binaryFile")} url={url} name={entry.name} />
        )}
      </div>

      {/* Discard-changes confirmation */}
      {confirmDiscard && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="card-surface rounded-2xl p-6 w-72 shadow-2xl">
            <h3 className="text-base font-semibold mb-4 text-[var(--text-primary)] flex items-center gap-2">
              <Icon name="warning" size={20} color="#f59e0b" />
              {t("files.unsavedChanges")}
            </h3>
            <div className="flex gap-2 justify-end">
              <button
                autoFocus
                onClick={() => setConfirmDiscard(false)}
                className="px-4 py-2 rounded-lg text-sm bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
              >
                {t("cancel")}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 cursor-pointer"
              >
                {t("files.discard")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Fallback panel for files that can't be shown inline (binary, too large, or a
// fetch error): explain why and offer a download.
function ViewerMessage({ icon, text, url, name, color }: {
  icon: string;
  text: string;
  url: string;
  name: string;
  color?: string;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center text-[var(--text-muted)]">
      <Icon name={icon} size={48} color={color ?? "var(--border-subtle)"} />
      <span className="text-sm max-w-sm">{text}</span>
      <button
        onClick={() => downloadViaLink(url, name)}
        className="flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-lg text-sm bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/25 cursor-pointer"
      >
        <Icon name="download" size={16} />{t("files.downloadInstead")}
      </button>
    </div>
  );
}
