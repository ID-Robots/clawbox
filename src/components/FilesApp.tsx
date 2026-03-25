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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAVORITES = [
  { label: "Home", icon: "🏠", path: "" },
  { label: "Documents", icon: "📄", path: "Documents" },
  { label: "Downloads", icon: "⬇️", path: "Downloads" },
  { label: "Desktop", icon: "🖥️", path: "Desktop" },
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

function FileIcon({ entry, large = false }: { entry: FileEntry; large?: boolean }) {
  const size = large ? "text-4xl" : "text-xl";
  if (entry.type === "directory") return <span className={size}>📁</span>;
  const ext = fileExtension(entry.name);
  const map: Record<string, string> = {
    pdf: "📕", doc: "📘", docx: "📘", xls: "📗", xlsx: "📗",
    ppt: "📙", pptx: "📙", txt: "📝", md: "📝", csv: "📊",
    jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
    mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵",
    zip: "📦", tar: "📦", gz: "📦", rar: "📦",
    js: "📜", ts: "📜", py: "🐍", json: "🔧", yaml: "🔧", yml: "🔧",
    sh: "⚙️", bash: "⚙️",
  };
  return <span className={size}>{map[ext] ?? "📄"}</span>;
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // ─── Load directory ────────────────────────────────────────────────────────

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSelected(null);
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
    setStatusMsg(`Uploading ${fileList.length} file(s)…`);
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

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden relative" style={{ background: "#1e1e2e", color: "#e0e0e0", fontFamily: "system-ui, sans-serif" }}>

      {/* ── Sidebar ── */}
      {sidebarOpen && (
        <>
          {/* Overlay on mobile to close sidebar when tapping outside */}
          <div
            className="fixed inset-0 z-[5] bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <aside style={{ width: 200, background: "#16161e", flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.07)" }}
            className="flex flex-col py-4 overflow-y-auto absolute md:relative z-[6] h-full">
            <div className="px-4 pb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(224,224,224,0.4)" }}>
              Favorites
            </div>
            {FAVORITES.map((fav) => {
              const active = currentPath === fav.path;
              return (
                <button
                  key={fav.path}
                  onClick={() => { load(fav.path); if (window.innerWidth < 768) setSidebarOpen(false); }}
                  className="flex items-center gap-2 px-4 py-2 text-sm transition-colors text-left"
                  style={{
                    background: active ? "rgba(255,255,255,0.08)" : "transparent",
                    color: active ? "#fff" : "rgba(224,224,224,0.7)",
                    borderLeft: active ? "2px solid #f97316" : "2px solid transparent",
                  }}
                >
                  <span>{fav.icon}</span>
                  <span>{fav.label}</span>
                </button>
              );
            })}

            <div className="mt-auto px-4 pt-4">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm transition-colors"
                style={{ background: "rgba(249,115,22,0.2)", color: "#f97316", border: "1px solid rgba(249,115,22,0.3)" }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>upload</span>
                Upload
              </button>
            </div>
          </aside>
        </>
      )}

      {/* ── Main area ── */}
      <div className="flex flex-col flex-1 min-w-0">

        {/* ── Toolbar ── */}
        <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "#1e1e2e" }}>
          {/* Sidebar toggle (visible on mobile) */}
          <button
            onClick={() => setSidebarOpen(p => !p)}
            className="p-1.5 rounded-md transition-colors md:hidden"
            style={{ color: "rgba(224,224,224,0.8)" }}
            title="Favorites"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>menu</span>
          </button>
          {/* Back */}
          <button
            onClick={() => {
              if (!currentPath) return;
              const parts = currentPath.split("/").filter(Boolean);
              parts.pop();
              load(parts.join("/"));
            }}
            disabled={!currentPath}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: currentPath ? "rgba(224,224,224,0.8)" : "rgba(224,224,224,0.25)", background: "transparent" }}
            title="Go up"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>chevron_left</span>
          </button>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 flex-1 text-sm overflow-hidden">
            {breadcrumbs.map((crumb, idx) => (
              <span key={idx} className="flex items-center gap-1 shrink-0">
                {idx > 0 && <span style={{ color: "rgba(224,224,224,0.3)" }}>›</span>}
                <button
                  onClick={() => navigateBreadcrumb(idx)}
                  className="hover:underline truncate max-w-[120px]"
                  style={{ color: idx === breadcrumbs.length - 1 ? "#e0e0e0" : "rgba(224,224,224,0.5)" }}
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            {/* New folder */}
            <button
              onClick={() => setDialog({ type: "mkdir", value: "" })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors"
              style={{ background: "rgba(255,255,255,0.06)", color: "rgba(224,224,224,0.8)" }}
              title="New Folder"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>create_new_folder</span>
              <span className="hidden sm:inline">New Folder</span>
            </button>

            {/* Refresh */}
            <button
              onClick={() => load(currentPath)}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: "rgba(224,224,224,0.6)", background: "transparent" }}
              title="Refresh"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span>
            </button>

            {/* View toggle */}
            <button
              onClick={() => setViewMode(v => v === "grid" ? "list" : "grid")}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: "rgba(224,224,224,0.6)", background: "transparent" }}
              title={viewMode === "grid" ? "Switch to list" : "Switch to grid"}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                {viewMode === "grid" ? "view_list" : "grid_view"}
              </span>
            </button>
          </div>
        </div>

        {/* ── File Area ── */}
        <div
          ref={dropZoneRef}
          className="flex-1 overflow-y-auto relative"
          style={{ background: dragOver ? "rgba(249,115,22,0.05)" : "transparent", transition: "background 0.15s" }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" style={{ border: "2px dashed rgba(249,115,22,0.5)", margin: 8, borderRadius: 12 }}>
              <div className="text-center" style={{ color: "#f97316" }}>
                <div className="text-4xl mb-2">⬆️</div>
                <div className="text-sm font-medium">Drop files to upload</div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-full" style={{ color: "rgba(224,224,224,0.4)" }}>
              <span className="material-symbols-rounded animate-spin mr-2" style={{ fontSize: 24 }}>progress_activity</span>
              Loading…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full flex-col gap-2" style={{ color: "#f87171" }}>
              <span className="text-3xl">⚠️</span>
              <span className="text-sm">{error}</span>
              <button onClick={() => load(currentPath)} className="text-xs underline mt-1" style={{ color: "rgba(224,224,224,0.5)" }}>Retry</button>
            </div>
          ) : files.length === 0 ? (
            <div className="flex items-center justify-center h-full flex-col gap-2" style={{ color: "rgba(224,224,224,0.3)" }}>
              <span className="text-5xl">📂</span>
              <span className="text-sm">Empty folder</span>
              <span className="text-xs">Drop files here or click Upload</span>
            </div>
          ) : viewMode === "grid" ? (
            <GridView
              files={files}
              selected={selected}
              onSelect={setSelected}
              onOpen={navigateTo}
              onDownload={downloadFile}
              onRename={(e) => setDialog({ type: "rename", entry: e, value: e.name })}
              onDelete={(e) => setDialog({ type: "delete", entry: e })}
            />
          ) : (
            <ListView
              files={files}
              selected={selected}
              onSelect={setSelected}
              onOpen={navigateTo}
              onDownload={downloadFile}
              onRename={(e) => setDialog({ type: "rename", entry: e, value: e.name })}
              onDelete={(e) => setDialog({ type: "delete", entry: e })}
            />
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="px-4 py-1.5 text-xs flex items-center justify-between shrink-0"
          style={{ borderTop: "1px solid rgba(255,255,255,0.07)", color: "rgba(224,224,224,0.4)" }}>
          <span>{statusMsg ?? `${files.length} item${files.length !== 1 ? "s" : ""}`}</span>
          {currentPath && <span style={{ color: "rgba(224,224,224,0.25)" }}>~/{currentPath}</span>}
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

function GridView({ files, selected, onSelect, onOpen, onDownload, onRename, onDelete }: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}) {
  return (
    <div className="p-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}
      onClick={() => onSelect(null)}>
      {files.map((entry) => {
        const isSelected = selected === entry.name;
        return (
          <div
            key={entry.name}
            className="flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer group relative transition-colors"
            style={{
              background: isSelected ? "rgba(249,115,22,0.15)" : "transparent",
              border: isSelected ? "1px solid rgba(249,115,22,0.4)" : "1px solid transparent",
            }}
            onClick={(e) => { e.stopPropagation(); onSelect(entry.name); }}
            onDoubleClick={() => entry.type === "directory" ? onOpen(entry) : onDownload(entry)}
          >
            <FileIcon entry={entry} large />
            <span className="text-xs text-center line-clamp-2 w-full leading-tight" style={{ color: "#e0e0e0", wordBreak: "break-word" }}>
              {entry.name}
            </span>
            {/* Hover actions */}
            <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5">
              {entry.type === "file" && (
                <ActionBtn title="Download" onClick={(e) => { e.stopPropagation(); onDownload(entry); }}>
                  ⬇️
                </ActionBtn>
              )}
              <ActionBtn title="Rename" onClick={(e) => { e.stopPropagation(); onRename(entry); }}>
                ✏️
              </ActionBtn>
              <ActionBtn title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(entry); }}>
                🗑️
              </ActionBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

function ListView({ files, selected, onSelect, onOpen, onDownload, onRename, onDelete }: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}) {
  return (
    <div className="w-full" onClick={() => onSelect(null)}>
      {/* Header */}
      <div className="grid px-4 py-2 text-xs font-medium sticky top-0"
        style={{
          gridTemplateColumns: "1fr 80px 160px 90px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          background: "#1e1e2e",
          color: "rgba(224,224,224,0.4)",
        }}>
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="text-right">Modified</span>
        <span className="text-right">Actions</span>
      </div>
      {files.map((entry) => {
        const isSelected = selected === entry.name;
        return (
          <div
            key={entry.name}
            className="grid px-4 py-2 items-center cursor-pointer group transition-colors"
            style={{
              gridTemplateColumns: "1fr 80px 160px 90px",
              background: isSelected ? "rgba(249,115,22,0.1)" : "transparent",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
            }}
            onClick={(e) => { e.stopPropagation(); onSelect(entry.name); }}
            onDoubleClick={() => entry.type === "directory" ? onOpen(entry) : onDownload(entry)}
          >
            <span className="flex items-center gap-2 truncate">
              <FileIcon entry={entry} />
              <span className="truncate text-sm" style={{ color: "#e0e0e0" }}>{entry.name}</span>
            </span>
            <span className="text-right text-xs" style={{ color: "rgba(224,224,224,0.5)" }}>{formatSize(entry.size)}</span>
            <span className="text-right text-xs" style={{ color: "rgba(224,224,224,0.5)" }}>{formatDate(entry.modified)}</span>
            <span className="flex items-center justify-end gap-1">
              {entry.type === "file" && (
                <ActionBtn title="Download" onClick={(e) => { e.stopPropagation(); onDownload(entry); }}>
                  ⬇️
                </ActionBtn>
              )}
              <ActionBtn title="Rename" onClick={(e) => { e.stopPropagation(); onRename(entry); }}>
                ✏️
              </ActionBtn>
              <ActionBtn title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(entry); }}>
                🗑️
              </ActionBtn>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Small action button ──────────────────────────────────────────────────────

function ActionBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="text-xs px-1 py-0.5 rounded transition-colors opacity-70 hover:opacity-100"
      style={{ background: "rgba(255,255,255,0.1)" }}
    >
      {children}
    </button>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onCancel}>
      <div
        className="rounded-2xl p-6 w-80 shadow-2xl"
        style={{ background: "#2a2a3e", border: "1px solid rgba(255,255,255,0.1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-4" style={{ color: "#e0e0e0" }}>{title}</h3>
        {isDelete ? (
          <p className="text-sm mb-5" style={{ color: "rgba(224,224,224,0.6)" }}>
            This action cannot be undone. {dialog.entry?.type === "directory" ? "All contents will be deleted." : ""}
          </p>
        ) : (
          <input
            ref={inputRef}
            autoFocus
            value={dialog.value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onCancel(); }}
            className="w-full px-3 py-2 rounded-lg text-sm mb-5 outline-none"
            style={{ background: "rgba(255,255,255,0.07)", color: "#e0e0e0", border: "1px solid rgba(255,255,255,0.12)" }}
            placeholder={dialog.type === "mkdir" ? "Folder name" : "New name"}
          />
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm transition-colors"
            style={{ background: "rgba(255,255,255,0.06)", color: "rgba(224,224,224,0.7)" }}
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: isDelete ? "#dc2626" : "#f97316", color: "#fff" }}
          >
            {isDelete ? "Delete" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
