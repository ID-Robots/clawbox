"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

interface FileEntry {
  name: string;
  type: "file" | "directory";
}

const HOME_PREFIX = "/home/clawbox";

function describePath(relativePath: string | null | undefined) {
  return relativePath ? `${HOME_PREFIX}/${relativePath.replace(/^\/+/, "")}` : HOME_PREFIX;
}

async function extractErrorMessage(response: Response, fallback: string) {
  const bodyText = await response.text().catch(() => "");
  if (!bodyText) return `${fallback} (${response.status})`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // Fall through to the raw body text below.
  }
  return `${fallback} (${response.status}): ${bodyText}`;
}

export default function ClawKeepPathPicker({
  open,
  title,
  onClose,
  onSelect,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
      if (!response.ok) {
        throw new Error(await extractErrorMessage(response, `Failed to read folders in ${dir || "home"}`));
      }
      const data = await response.json() as { files: FileEntry[] };
      setEntries(data.files.filter((entry) => entry.type === "directory"));
      setCurrentPath(dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read folders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load("");
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const breadcrumbs = useMemo(() => ["Home", ...currentPath.split("/").filter(Boolean)], [currentPath]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[560px] rounded-[28px] border border-white/10 bg-[#121927] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div id={titleId} className="text-lg font-semibold text-white">{title}</div>
            <div className="text-xs text-white/50">{describePath(currentPath)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 transition hover:bg-white/10"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <div className="flex flex-wrap gap-1 border-b border-white/10 px-5 py-3">
          {breadcrumbs.map((crumb, index) => {
            const next = index === 0 ? "" : currentPath.split("/").filter(Boolean).slice(0, index).join("/");
            return (
              <button
                key={`${crumb}-${index}`}
                type="button"
                onClick={() => void load(next)}
                className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/80 transition hover:bg-white/10"
              >
                {crumb}
              </button>
            );
          })}
        </div>
        <div className="max-h-[360px] overflow-y-auto px-5 py-4">
          {loading && <div className="py-8 text-sm text-white/60">Loading folders...</div>}
          {error && <div className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>}
          {!loading && !error && (
            <div className="space-y-2">
              {entries.length === 0 && (
                <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-white/55">
                  No folders in this location yet.
                </div>
              )}
              {entries.map((entry) => {
                const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
                return (
                  <button
                    key={nextPath}
                    type="button"
                    onClick={() => void load(nextPath)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-left transition hover:border-orange-400/25 hover:bg-orange-500/8"
                  >
                    <span className="material-symbols-rounded text-orange-300" style={{ fontSize: 20 }}>folder</span>
                    <span className="text-sm font-medium text-white">{entry.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-white/10 px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-xl bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10">
            Cancel
          </button>
          <button type="button" onClick={() => onSelect(currentPath)} className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600">
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
