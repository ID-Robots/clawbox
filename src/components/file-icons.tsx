/**
 * The Files app's icons and sizes, shared with the Coding Agent's project
 * explorer so a folder looks the same in both — one map, not a second copy
 * that drifts a colour at a time.
 */

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot !== -1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fileIcon(name: string, type: "file" | "directory"): { icon: string; color: string } {
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
    jsx: { icon: "code", color: "#facc15" },
    mjs: { icon: "code", color: "#facc15" },
    ts: { icon: "code", color: "#3b82f6" },
    tsx: { icon: "code", color: "#3b82f6" },
    py: { icon: "code", color: "#22c55e" },
    html: { icon: "code", color: "#f97316" },
    css: { icon: "code", color: "#38bdf8" },
    json: { icon: "data_object", color: "#f59e0b" },
    yaml: { icon: "settings", color: "#9ca3af" },
    yml: { icon: "settings", color: "#9ca3af" },
    sh: { icon: "terminal", color: "#22c55e" },
    bash: { icon: "terminal", color: "#22c55e" },
  };
  return map[ext] ?? { icon: "draft", color: "#6b7280" };
}

export function Icon({ name, size = 20, color, className = "", ariaLabel }: { name: string; size?: number; color?: string; className?: string; ariaLabel?: string }) {
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
