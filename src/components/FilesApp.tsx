"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number | null;
  modified: string;
}

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
  { label: "Home", icon: "home", path: "" },
  { label: "Documents", icon: "description", path: "Documents" },
  { label: "Downloads", icon: "download", path: "Downloads" },
  { label: "Desktop", icon: "desktop_windows", path: "Desktop" },
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
  const [currentPath, setCurrentPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: null });
  const [dragOver, setDragOver] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" ? window.innerWidth >= 768 : true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [baseDir, setBaseDir] = useState("/home/clawbox");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; entry: FileEntry } | null>(null);

  // ─── Load directory ────────────────────────────────────────────────────────

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      if (data.baseDir) setBaseDir(data.baseDir);
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

  // ─── Breadcrumbs ────────────────────────────────────────────────────────────

  const breadcrumbs = ["Home", ...currentPath.split("/").filter(Boolean)];

  const navigateBreadcrumb = (idx: number) => {
    if (idx === 0) { load(""); return; }
    const parts = currentPath.split("/").filter(Boolean).slice(0, idx);
    load(parts.join("/"));
  };

  // ─── Navigation ────────────────────────────────────────────────────────────

  const navigateTo = (entry: FileEntry) => {
    if (entry.type === "directory") {
      const next = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      load(next);
    }
  };

  // ─── Download ──────────────────────────────────────────────────────────────

  const downloadFile = (entry: FileEntry) => {
    const filePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const url = `/setup-api/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.name;
    a.click();
  };

  // ─── Upload ────────────────────────────────────────────────────────────────

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setStatusMsg(`Uploading ${fileList.length} file(s)...`);
    let ok = 0;
    for (const file of Array.from(fileList)) {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/setup-api/files?dir=${encodeURIComponent(currentPath)}`, {
        method: "POST", body: form,
      });
      if (res.ok) ok++;
    }
    setStatusMsg(`Uploaded ${ok}/${fileList.length} file(s)`);
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
    const filePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const url = `/setup-api/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName }),
    });
    const data = await res.json();
    if (!res.ok) { setStatusMsg(`Error: ${data.error}`); return; }
    setStatusMsg("Renamed");
    setTimeout(() => setStatusMsg(null), 2000);
    load(currentPath);
  };

  // ─── Delete ───────────────────────────────────────────────────────────────

  const deleteEntry = async (entry: FileEntry) => {
    const filePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const url = `/setup-api/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) { setStatusMsg(`Error: ${data.error}`); return; }
    setStatusMsg("Deleted");
    setTimeout(() => setStatusMsg(null), 2000);
    load(currentPath);
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

  // ─── Open in VS Code ───────────────────────────────────────────────────────

  const openInVSCode = (entry: FileEntry) => {
    const sep = baseDir.endsWith("/") ? "" : "/";
    const absPath = `${baseDir}${sep}${currentPath ? currentPath + "/" : ""}${entry.name}`;
    window.dispatchEvent(new CustomEvent("clawbox:open-in-vscode", { detail: { filePath: absPath } }));
  };

  // ─── Context menu ──────────────────────────────────────────────────────────

  const openContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(entry.name);
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
        setSelected(entry.name);
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
    <div className="flex h-full overflow-hidden relative bg-[var(--bg-deep)] text-[var(--text-primary)] font-body" onClick={closeContextMenu}>

      {/* ── Sidebar ── */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-[5] bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="flex flex-col py-4 overflow-y-auto absolute md:relative z-[6] h-full w-[200px] shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)]">
            <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
              Favorites
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
                  <span>{fav.label}</span>
                </button>
              );
            })}

            <div className="mt-auto px-4 pt-4">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors bg-[var(--coral-bright)]/15 text-[var(--coral-bright)] border border-[var(--coral-bright)]/30 hover:bg-[var(--coral-bright)]/25 cursor-pointer"
              >
                <Icon name="upload" size={16} />
                Upload
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
            title="Go up"
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
              onClick={() => setDialog({ type: "mkdir", value: "" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.1] cursor-pointer"
              title="New Folder"
            >
              <Icon name="create_new_folder" size={16} />
              <span className="hidden sm:inline">New Folder</span>
            </button>
            <button
              onClick={() => load(currentPath)}
              className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title="Refresh"
            >
              <Icon name="refresh" size={18} />
            </button>
            <button
              onClick={() => setViewMode(v => v === "grid" ? "list" : "grid")}
              className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] cursor-pointer"
              title={viewMode === "grid" ? "Switch to list" : "Switch to grid"}
            >
              <Icon name={viewMode === "grid" ? "view_list" : "grid_view"} size={18} />
            </button>
          </div>
        </div>

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
                <div className="text-sm font-medium">Drop files to upload</div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              <Icon name="progress_activity" size={24} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full flex-col gap-2 text-red-400">
              <Icon name="error" size={40} />
              <span className="text-sm">{error}</span>
              <button onClick={() => load(currentPath)} className="text-xs underline mt-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">Retry</button>
            </div>
          ) : files.length === 0 ? (
            <div className="flex items-center justify-center h-full flex-col gap-2 text-[var(--text-muted)]">
              <Icon name="folder_open" size={56} color="var(--border-subtle)" />
              <span className="text-sm">Empty folder</span>
              <span className="text-xs">Drop files here or click Upload</span>
            </div>
          ) : viewMode === "grid" ? (
            <GridView
              files={files}
              selected={selected}
              onSelect={setSelected}
              onOpen={navigateTo}
              onOpenFile={openInVSCode}
              onContextMenu={openContextMenu}
              onLongPressStart={handleLongPressStart}
              onLongPressEnd={handleLongPressEnd}
            />
          ) : (
            <ListView
              files={files}
              selected={selected}
              onSelect={setSelected}
              onOpen={navigateTo}
              onOpenFile={openInVSCode}
              onContextMenu={openContextMenu}
              onLongPressStart={handleLongPressStart}
              onLongPressEnd={handleLongPressEnd}
            />
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="px-4 py-1.5 text-xs flex items-center justify-between shrink-0 border-t border-[var(--border-subtle)] text-[var(--text-muted)]">
          <span>{statusMsg ?? `${files.length} item${files.length !== 1 ? "s" : ""}`}</span>
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
          onOpenInVSCode={() => { closeContextMenu(); openInVSCode(contextMenu.entry); }}
          onRename={() => { closeContextMenu(); setDialog({ type: "rename", entry: contextMenu.entry, value: contextMenu.entry.name }); }}
          onDelete={() => { closeContextMenu(); setDialog({ type: "delete", entry: contextMenu.entry }); }}
          onClose={closeContextMenu}
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

function GridView({ files, selected, onSelect, onOpen, onOpenFile, onContextMenu, onLongPressStart, onLongPressEnd }: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  onOpenFile: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onLongPressStart: (e: React.TouchEvent, entry: FileEntry) => void;
  onLongPressEnd: () => void;
}) {
  return (
    <div className="p-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}
      onClick={() => onSelect(null)}>
      {files.map((entry) => {
        const isSelected = selected === entry.name;
        const fi = fileIcon(entry.name, entry.type);
        return (
          <div
            key={entry.name}
            className={`flex flex-col items-center gap-1.5 p-3 rounded-xl cursor-pointer transition-all select-none ${
              isSelected
                ? "bg-[var(--coral-bright)]/10 border border-[var(--coral-bright)]/40"
                : "border border-transparent hover:bg-white/[0.04]"
            }`}
            onClick={(e) => { e.stopPropagation(); onSelect(entry.name); }}
            onDoubleClick={() => entry.type === "directory" ? onOpen(entry) : onOpenFile(entry)}
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

function ListView({ files, selected, onSelect, onOpen, onOpenFile, onContextMenu, onLongPressStart, onLongPressEnd }: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  onOpenFile: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onLongPressStart: (e: React.TouchEvent, entry: FileEntry) => void;
  onLongPressEnd: () => void;
}) {
  return (
    <div className="w-full" onClick={() => onSelect(null)}>
      {/* Header */}
      <div className="grid px-4 py-2 text-xs font-medium sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-deep)] text-[var(--text-muted)]"
        style={{ gridTemplateColumns: "1fr 80px 160px" }}>
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="text-right">Modified</span>
      </div>
      {files.map((entry) => {
        const isSelected = selected === entry.name;
        const fi = fileIcon(entry.name, entry.type);
        return (
          <div
            key={entry.name}
            className={`grid px-4 py-2 items-center cursor-pointer transition-colors border-b border-white/[0.03] select-none ${
              isSelected ? "bg-[var(--coral-bright)]/10" : "hover:bg-white/[0.03]"
            }`}
            style={{ gridTemplateColumns: "1fr 80px 160px" }}
            onClick={(e) => { e.stopPropagation(); onSelect(entry.name); }}
            onDoubleClick={() => entry.type === "directory" ? onOpen(entry) : onOpenFile(entry)}
            onContextMenu={(e) => onContextMenu(e, entry)}
            onTouchStart={(e) => onLongPressStart(e, entry)}
            onTouchEnd={onLongPressEnd}
            onTouchMove={onLongPressEnd}
          >
            <span className="flex items-center gap-2.5 truncate">
              <Icon name={fi.icon} size={20} color={fi.color} />
              <span className="truncate text-sm text-[var(--text-primary)]">{entry.name}</span>
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

function ContextMenu({ entry, x, y, onOpen, onDownload, onOpenInVSCode, onRename, onDelete, onClose }: {
  entry: FileEntry;
  x: number;
  y: number;
  onOpen: () => void;
  onDownload: () => void;
  onOpenInVSCode: () => void;
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

  const items: { icon: string; label: string; onClick: () => void; danger?: boolean; color?: string }[] = [];

  if (entry.type === "directory") {
    items.push({ icon: "folder_open", label: "Open", onClick: onOpen });
  } else {
    items.push({ icon: "download", label: "Download", onClick: onDownload });
  }
  items.push({ icon: "code", label: "Open in VS Code", onClick: onOpenInVSCode, color: "#007acc" });
  items.push({ icon: "edit", label: "Rename", onClick: onRename });
  items.push({ icon: "delete", label: "Delete", onClick: onDelete, danger: true });

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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dialog.type !== "delete") inputRef.current?.select(); }, [dialog.type]);

  const isDelete = dialog.type === "delete";
  const title = dialog.type === "mkdir" ? "New Folder"
    : dialog.type === "rename" ? "Rename"
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
            This action cannot be undone. {dialog.entry?.type === "directory" ? "All contents will be deleted." : ""}
          </p>
        ) : (
          <input
            ref={inputRef}
            autoFocus
            value={dialog.value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onCancel(); }}
            className="w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500 mb-5"
            placeholder={dialog.type === "mkdir" ? "Folder name" : "New name"}
          />
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm transition-colors bg-white/[0.06] text-[var(--text-secondary)] hover:bg-white/[0.1] hover:text-[var(--text-primary)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer text-white ${
              isDelete
                ? "bg-red-600 hover:bg-red-500"
                : "btn-gradient hover:opacity-90"
            }`}
          >
            {isDelete ? "Delete" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
