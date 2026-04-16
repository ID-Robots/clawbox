"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

interface ClawKeepLogEntry {
  hash: string;
  date: string;
  message: string;
}

interface ClawKeepStatus {
  initialized: boolean;
  sourcePath: string;
  sourceAbsolutePath: string;
  sourceExists: boolean;
  backup: {
    target: string | null;
    targetLabel: string;
    passwordSet: boolean;
    wrappedKeySet: boolean;
    workspaceId: string | null;
    chunkCount: number;
    lastSync: string | null;
    lastSyncCommit: string | null;
  };
  headCommit: string | null;
  trackedFiles: number;
  totalSnaps: number;
  dirtyFiles: number;
  clean: boolean;
  recent: ClawKeepLogEntry[];
}

interface FileEntry {
  name: string;
  type: "file" | "directory";
}

const HOME_PREFIX = "/home/clawbox";

function describePath(relativePath: string) {
  return relativePath ? `${HOME_PREFIX}/${relativePath}` : HOME_PREFIX;
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function PathPicker({
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
        const bodyText = await response.text().catch(() => "");
        let errorMessage = `Failed to read folders in ${dir || "home"} (${response.status})`;
        if (bodyText) {
          try {
            const parsed = JSON.parse(bodyText) as { error?: string };
            if (parsed.error) errorMessage = parsed.error;
          } catch {
            errorMessage = `${errorMessage}: ${bodyText}`;
          }
        }
        throw new Error(errorMessage);
      }
      const data = await response.json() as { files: FileEntry[] };
      setEntries((data.files as FileEntry[]).filter((entry) => entry.type === "directory"));
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
    const initial = focusable()[0];
    initial?.focus();

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

  const breadcrumbs = useMemo(
    () => ["Home", ...currentPath.split("/").filter(Boolean)],
    [currentPath],
  );

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
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSelect(currentPath)}
            className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ClawKeepApp() {
  const [sourcePath, setSourcePath] = useState("Documents");
  const [targetPath, setTargetPath] = useState("Backups/clawkeep");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<ClawKeepStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<"source" | "target" | null>(null);

  const loadStatus = useCallback(async (nextSourcePath: string) => {
    setError(null);
    try {
      const response = await fetch(`/setup-api/clawkeep?sourcePath=${encodeURIComponent(nextSourcePath)}`, { cache: "no-store" });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        let errorMessage = `Failed to load ClawKeep for ${nextSourcePath} (${response.status})`;
        if (bodyText) {
          try {
            const parsed = JSON.parse(bodyText) as { error?: string };
            if (parsed.error) errorMessage = parsed.error;
          } catch {
            errorMessage = `${errorMessage}: ${bodyText}`;
          }
        }
        throw new Error(errorMessage);
      }
      const data = await response.json();
      setStatus(data as ClawKeepStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ClawKeep");
    }
  }, []);

  useEffect(() => {
    void loadStatus(sourcePath);
  }, [loadStatus, sourcePath]);

  const runAction = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/setup-api/clawkeep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePath, ...body }),
      });
      if (!response.ok) {
        let errorMessage = `ClawKeep request failed (${response.status})`;
        try {
          const parsed = await response.json() as { error?: string };
          if (parsed.error) errorMessage = parsed.error;
        } catch {
          const bodyText = await response.text().catch(() => "");
          if (bodyText) errorMessage = `${errorMessage}: ${bodyText}`;
        }
        throw new Error(errorMessage);
      }
      const data = await response.json();
      if ("status" in data && data.status) {
        setStatus(data.status as ClawKeepStatus);
      } else if ("initialized" in data) {
        setStatus(data as ClawKeepStatus);
      }
      if (typeof data.message === "string") {
        setNotice(data.message);
      } else {
        setNotice("Done");
      }
      if (body.action === "configure") {
        setPassword("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ClawKeep request failed");
    } finally {
      setBusy(false);
    }
  }, [sourcePath]);

  return (
    <div className="h-full overflow-y-auto bg-[linear-gradient(180deg,#0f1726_0%,#101826_45%,#0b1320_100%)]">
      <PathPicker
        open={picker === "source"}
        title="Choose a source folder to protect"
        onClose={() => setPicker(null)}
        onSelect={(path) => {
          setSourcePath(path);
          setPicker(null);
          void loadStatus(path);
        }}
      />
      <PathPicker
        open={picker === "target"}
        title="Choose a backup target on this device"
        onClose={() => setPicker(null)}
        onSelect={(path) => {
          setTargetPath(path);
          setPicker(null);
        }}
      />

      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-5 sm:p-6">
        <div className="rounded-[32px] border border-white/10 bg-[linear-gradient(135deg,rgba(249,115,22,0.16),rgba(249,115,22,0.03)_35%,rgba(255,255,255,0.02)_100%)] p-6 shadow-[0_20px_80px_rgba(0,0,0,0.35)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/20 bg-orange-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-orange-100">
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>shield_lock</span>
                ClawKeep Local
              </div>
              <h1 className="mt-4 text-3xl font-bold text-white">Private backups, copied to this device first</h1>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/72">
                This first ClawBox version vendors the ClawKeep local backup flow: protect one folder, snapshot changes with Git, and sync encrypted backup chunks to another device path.
                Server upload can layer on top next.
              </p>
            </div>
            <div className="grid min-w-[260px] grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Snaps</div>
                <div className="mt-2 text-2xl font-semibold text-white">{status?.totalSnaps ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Encrypted Chunks</div>
                <div className="mt-2 text-2xl font-semibold text-white">{status?.backup.chunkCount ?? 0}</div>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-50">
            {notice}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-[28px] border border-white/10 bg-[#131b2a]/95 p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-orange-300" style={{ fontSize: 20 }}>folder_managed</span>
              <h2 className="text-lg font-semibold text-white">Protected Folder</h2>
            </div>
            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Source path</label>
                <div className="flex gap-2">
                  <input
                    value={sourcePath}
                    onChange={(event) => setSourcePath(event.target.value.replace(/^\/+/, ""))}
                    className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400/40"
                    placeholder="Documents"
                  />
                  <button
                    type="button"
                    onClick={() => setPicker("source")}
                    className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08]"
                  >
                    Browse
                  </button>
                </div>
                <div className="mt-2 text-xs text-white/45">{describePath(sourcePath)}</div>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void loadStatus(sourcePath)}
                  disabled={busy}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void runAction({ action: "init" })}
                  disabled={busy}
                  className="rounded-2xl bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:opacity-50"
                >
                  {status?.initialized ? "Protected" : "Protect this folder"}
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Status</div>
                  <div className="mt-2 text-sm font-medium text-white">
                    {status?.initialized ? "ClawKeep is active here" : "Not initialized yet"}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    {status?.sourceExists ? "Folder exists on device." : "Folder will be created when you initialize it."}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Working tree</div>
                  <div className="mt-2 text-sm font-medium text-white">
                    {status?.clean ? "No unsnapped changes" : `${status?.dirtyFiles ?? 0} pending change${status?.dirtyFiles === 1 ? "" : "s"}`}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    {status?.trackedFiles ?? 0} tracked files
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Snapshot message</label>
                <div className="flex gap-2">
                  <input
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400/40"
                    placeholder="manual snapshot"
                  />
                  <button
                    type="button"
                    onClick={() => void runAction({ action: "snap", message })}
                    disabled={busy || !status?.initialized}
                    className="rounded-2xl bg-white/8 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/12 disabled:opacity-50"
                  >
                    Snap now
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#131b2a]/95 p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-emerald-300" style={{ fontSize: 20 }}>encrypted</span>
              <h2 className="text-lg font-semibold text-white">Local Backup Target</h2>
            </div>
            <div className="mt-5 space-y-4">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Target path</label>
                <div className="flex gap-2">
                  <input
                    value={targetPath}
                    onChange={(event) => setTargetPath(event.target.value.replace(/^\/+/, ""))}
                    className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/40"
                    placeholder="Backups/clawkeep"
                  />
                  <button
                    type="button"
                    onClick={() => setPicker("target")}
                    className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08]"
                  >
                    Browse
                  </button>
                </div>
                <div className="mt-2 text-xs text-white/45">{describePath(targetPath)}</div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Encryption password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/40"
                  placeholder={status?.backup.passwordSet ? "Enter a new password only if you want to rotate it" : "At least 8 characters"}
                />
                <div className="mt-2 text-xs text-white/45">
                  This local-only phase stores wrapped key material in the protected folder so future syncs can run without asking again.
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Target</div>
                  <div className="mt-2 text-sm font-medium text-white">{status?.backup.targetLabel ?? "Not configured"}</div>
                  <div className="mt-1 text-xs text-white/50">
                    {status?.backup.passwordSet ? "Password configured" : "Password not set"}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Last sync</div>
                  <div className="mt-2 text-sm font-medium text-white">
                    {status?.backup.lastSync ? timeAgo(status.backup.lastSync) : "Never synced"}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    Workspace {status?.backup.workspaceId ?? "pending"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const trimmedPassword = password.trim();
                    void runAction({ action: "configure", targetPath, password: trimmedPassword });
                  }}
                  disabled={busy || !status?.initialized || password.trim().length < 8}
                  className="rounded-2xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
                >
                  Save local target
                </button>
                <button
                  type="button"
                  onClick={() => void runAction({ action: "sync" })}
                  disabled={busy || !status?.initialized || !status?.backup.passwordSet || status?.backup.target !== "local"}
                  className="rounded-2xl border border-emerald-400/20 bg-emerald-500/12 px-4 py-2.5 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-500/18 disabled:opacity-50"
                >
                  Sync encrypted backup
                </button>
              </div>
            </div>
          </section>
        </div>

        <section className="rounded-[28px] border border-white/10 bg-[#131b2a]/95 p-5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-rounded text-sky-300" style={{ fontSize: 20 }}>history</span>
            <h2 className="text-lg font-semibold text-white">Recent Timeline</h2>
          </div>
          <div className="mt-5 space-y-3">
            {!status?.recent.length && (
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-white/55">
                No snapshots yet. Initialize the folder, then create a manual snapshot or sync after making changes.
              </div>
            )}
            {status?.recent.map((entry) => (
              <div
                key={entry.hash}
                className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-white">{entry.message}</div>
                  <div className="mt-1 text-xs text-white/45">{entry.hash.slice(0, 8)} · {timeAgo(entry.date)}</div>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-white/55">
                  snap
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
