"use client";

import { useCallback, useEffect, useState } from "react";
import ClawKeepPathPicker from "@/components/ClawKeepPathPicker";

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
    mode: "local" | "cloud" | "both" | null;
    passwordSet: boolean;
    workspaceId: string | null;
    chunkCount: number;
    lastSync: string | null;
    lastSyncCommit: string | null;
    local: {
      enabled: boolean;
      path: string | null;
      lastSync: string | null;
      ready: boolean;
    };
    cloud: {
      enabled: boolean;
      connected: boolean;
      available: boolean;
      providerLabel: string;
      endpoint: string | null;
      lastSync: string | null;
    };
  };
  headCommit: string | null;
  trackedFiles: number;
  totalSnaps: number;
  dirtyFiles: number;
  clean: boolean;
  recent: ClawKeepLogEntry[];
}

interface ClawKeepAppProps {
  onOpenAiProviderSettings?: () => void;
}

const HOME_PREFIX = "/home/clawbox";

function describePath(relativePath: string | null | undefined) {
  return relativePath ? `${HOME_PREFIX}/${relativePath.replace(/^\/+/, "")}` : HOME_PREFIX;
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

function normalizeBackupLocalPath(backupPath: string | null | undefined) {
  return backupPath?.replace(/^\/home\/clawbox\/?/, "") ?? "";
}

function hasBackupConfigChanged(
  status: ClawKeepStatus | null,
  localEnabled: boolean,
  cloudEnabled: boolean,
  localPath: string,
) {
  return (
    !status?.backup.passwordSet ||
    localEnabled !== !!status?.backup.local.enabled ||
    cloudEnabled !== !!status?.backup.cloud.enabled ||
    (localEnabled && localPath !== (status?.backup.local.path?.replace(/^\/home\/clawbox\/?/, "") ?? ""))
  );
}

export default function ClawKeepApp({ onOpenAiProviderSettings }: ClawKeepAppProps) {
  const [sourcePath, setSourcePath] = useState("Documents");
  const [localPath, setLocalPath] = useState("Backups/clawkeep");
  const [password, setPassword] = useState("");
  const [localEnabled, setLocalEnabled] = useState(true);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [status, setStatus] = useState<ClawKeepStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<"source" | "local" | null>(null);

  const loadStatus = useCallback(async (nextSourcePath: string) => {
    setError(null);
    try {
      const response = await fetch(`/setup-api/clawkeep?sourcePath=${encodeURIComponent(nextSourcePath)}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await extractErrorMessage(response, `Failed to load ClawKeep for ${nextSourcePath}`));
      }
      const data = await response.json() as ClawKeepStatus;
      setStatus(data);
      setLocalEnabled(data.backup.local.enabled || !data.backup.mode);
      setCloudEnabled(data.backup.cloud.enabled);
      if (data.backup.local.path) {
        setLocalPath(normalizeBackupLocalPath(data.backup.local.path));
      }
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
        throw new Error(await extractErrorMessage(response, "ClawKeep request failed"));
      }
      const data = await response.json();
      if ("status" in data && data.status) {
        setStatus(data.status as ClawKeepStatus);
      } else if ("initialized" in data) {
        setStatus(data as ClawKeepStatus);
      }
      if (typeof data.message === "string") {
        setNotice(data.message);
      }
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : "ClawKeep request failed";
      setError(message);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [sourcePath]);

  const handleSavePlan = useCallback(async () => {
    const trimmedPassword = password.trim();
    if (trimmedPassword.length < 8 && !status?.backup.passwordSet) {
      setError("Choose a password with at least 8 characters.");
      return;
    }
    await runAction({
      action: "configure",
      localPath: localEnabled ? localPath : "",
      cloudEnabled,
      password: trimmedPassword.length >= 8 ? trimmedPassword : password,
    });
    if (trimmedPassword.length >= 8) setPassword("");
  }, [cloudEnabled, localEnabled, localPath, password, runAction, status?.backup.passwordSet]);

  const handleBackupNow = useCallback(async () => {
    const trimmedPassword = password.trim();
    const needsConfigUpdate = hasBackupConfigChanged(status, localEnabled, cloudEnabled, localPath);
    if (needsConfigUpdate && trimmedPassword.length < 8 && !status?.backup.passwordSet) {
      setError("Choose a password with at least 8 characters before turning on backup.");
      return;
    }
    if (!status?.initialized) {
      await runAction({ action: "init" });
    }
    if (needsConfigUpdate) {
      await runAction({
        action: "configure",
        localPath: localEnabled ? localPath : "",
        cloudEnabled,
        password: trimmedPassword.length >= 8 ? trimmedPassword : password,
      });
      if (trimmedPassword.length >= 8) setPassword("");
    }
    await runAction({ action: "snap", message: `backup ${new Date().toISOString()}` });
    await runAction({ action: "sync" });
  }, [cloudEnabled, localEnabled, localPath, password, runAction, status]);

  const canBackup = localEnabled || cloudEnabled;
  const cloudNeedsConnection = cloudEnabled && !status?.backup.cloud.connected;
  const destinationLabel = localEnabled && cloudEnabled
    ? "This device + Cloud"
    : localEnabled
      ? "This device"
      : cloudEnabled
        ? "Cloud"
        : "Choose a destination";
  const primaryActionLabel = status?.initialized ? "Back up now" : "Turn on backup";

  return (
    <div data-testid="clawkeep-app" className="h-full overflow-y-auto bg-[linear-gradient(180deg,#0f1726_0%,#101826_45%,#0b1320_100%)]">
      <ClawKeepPathPicker
        open={picker === "source"}
        title="Choose the folder you want to protect"
        onClose={() => setPicker(null)}
        onSelect={(path) => {
          setSourcePath(path);
          setPicker(null);
          void loadStatus(path);
        }}
      />
      <ClawKeepPathPicker
        open={picker === "local"}
        title="Choose where local backup copies should live"
        onClose={() => setPicker(null)}
        onSelect={(path) => {
          setLocalPath(path);
          setPicker(null);
        }}
      />

      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-5 sm:p-6">
        {error && <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>}
        {notice && <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-50">{notice}</div>}

        <section className="rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(19,27,42,0.98),rgba(15,22,36,0.98))] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.28)] sm:p-6">
          <div className="mx-auto max-w-2xl space-y-5">
            <div className="space-y-2">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-orange-400/20 bg-orange-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-orange-100">
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>shield_lock</span>
                Simple backup
              </div>
              <h1 className="text-3xl font-bold text-white">Back up one folder</h1>
              <p className="max-w-xl text-sm leading-relaxed text-white/70">
                Choose what to protect, where copies should go, and press one button.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Folder</div>
                <div className="mt-2 text-sm font-semibold text-white">{sourcePath || "Not chosen"}</div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Destination</div>
                <div className="mt-2 text-sm font-semibold text-white">{destinationLabel}</div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">Last backup</div>
                <div className="mt-2 text-sm font-semibold text-white">{status?.backup.lastSync ? timeAgo(status.backup.lastSync) : "Never"}</div>
              </div>
            </div>

            <div className="space-y-4 rounded-[26px] border border-white/8 bg-white/[0.03] p-5">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Folder</label>
                <div className="flex gap-2">
                  <input
                    value={sourcePath}
                    onChange={(event) => setSourcePath(event.target.value.replace(/^\/+/, ""))}
                    className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-orange-400/40"
                    placeholder="Documents"
                  />
                  <button type="button" onClick={() => setPicker("source")} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08]">
                    Browse
                  </button>
                </div>
                <div className="mt-2 text-xs text-white/45">{describePath(sourcePath)}</div>
              </div>

              <div>
                <div className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Where to copy it</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {[
                    { id: "local", label: "This device", active: localEnabled && !cloudEnabled, onClick: () => { setLocalEnabled(true); setCloudEnabled(false); } },
                    { id: "cloud", label: "Cloud", active: !localEnabled && cloudEnabled, onClick: () => { setLocalEnabled(false); setCloudEnabled(true); } },
                    { id: "both", label: "Both", active: localEnabled && cloudEnabled, onClick: () => { setLocalEnabled(true); setCloudEnabled(true); } },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      data-testid={option.id === "cloud" ? "cloud-toggle" : undefined}
                      aria-pressed={option.active}
                      onClick={option.onClick}
                      className={`rounded-2xl border px-4 py-3 text-left text-sm font-medium transition ${
                        option.active
                          ? "border-emerald-400/30 bg-emerald-500/12 text-white"
                          : "border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/[0.06]"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {localEnabled && (
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Local folder</label>
                  <div className="flex gap-2">
                    <input
                      value={localPath}
                      onChange={(event) => setLocalPath(event.target.value.replace(/^\/+/, ""))}
                      className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/40"
                      placeholder="Backups/clawkeep"
                    />
                    <button type="button" onClick={() => setPicker("local")} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08]">
                      Browse
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-white/45">{describePath(localPath)}</div>
                </div>
              )}

              {cloudEnabled && (
                <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/8 p-4">
                  <div className="text-sm font-semibold text-white">{status?.backup.cloud.providerLabel ?? "ClawBox AI"}</div>
                  <div className="mt-1 text-xs text-white/65">
                    {status?.backup.cloud.connected
                      ? "Cloud backup is ready."
                      : "Connect ClawBox AI first."}
                  </div>
                  {!status?.backup.cloud.connected && (
                    <button
                      type="button"
                      onClick={() => onOpenAiProviderSettings?.()}
                      className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-50 transition hover:bg-emerald-500/20"
                    >
                      Connect ClawBox AI
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/40"
                  placeholder={status?.backup.passwordSet ? "Leave blank to keep your current password" : "At least 8 characters"}
                />
                <div className="mt-2 text-xs text-white/45">One password protects every copy.</div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleBackupNow()}
                  disabled={busy || !canBackup || cloudNeedsConnection}
                  className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
                >
                  {primaryActionLabel}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSavePlan()}
                  disabled={busy || !canBackup || cloudNeedsConnection}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
                >
                  Save settings
                </button>
                <button
                  type="button"
                  onClick={() => void loadStatus(sourcePath)}
                  disabled={busy}
                  className="text-sm font-medium text-white/60 transition hover:text-white disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black/15 px-4 py-3 text-sm text-white/72">
                {status?.initialized
                  ? `${sourcePath || "This folder"} is protected. ${status?.backup.chunkCount ? `${status.backup.chunkCount} encrypted chunk${status.backup.chunkCount === 1 ? "" : "s"} stored.` : "Run backup any time."}`
                  : "Your first backup will set everything up automatically."}
              </div>

              {status?.recent[0] && (
                <div className="text-xs text-white/45">
                  Latest snap: {status.recent[0].message} · {timeAgo(status.recent[0].date)}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
