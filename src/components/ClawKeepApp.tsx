"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";

type ScheduleFrequency = "daily" | "weekly";
interface ClawKeepSchedule {
  enabled: boolean;
  frequency: ScheduleFrequency;
  timeOfDay: string;
  weekday: number;
}
interface ClawKeepStatus {
  paired: boolean;
  configured: boolean;
  server: string;
  lastBackupAtMs: number;
  lastHeartbeatAtMs: number;
  lastHeartbeatStatus: string;
  currentStep: string;
  currentStepAtMs: number;
  cloudBytes: number;
  snapshotCount: number;
  openclawInstalled: boolean;
  daemonInstalled: boolean;
  schedule: ClawKeepSchedule;
  nextRunAtMs: number;
}

// Map the daemon's phase id to a friendly label for the progress panel.
// Keys must match clawkeep/clawkeep/runner.py: STEP_* constants — keep in
// lockstep when adding/renaming phases.
const STEP_LABELS: Record<string, string> = {
  starting: "Connecting to ClawKeep…",
  archiving: "Building openclaw archive…",
  uploading: "Encrypting and uploading to your prefix…",
  "checking-stats": "Verifying cloud snapshot…",
};

// If a "running" status hasn't been refreshed in this many ms, assume the
// daemon crashed (systemd timer kill, OOM, …) and stop showing the
// progress panel — otherwise reopens would spin forever after a fault.
const STALE_RUNNING_MS = 4 * 60 * 60 * 1000; // matches systemd TimeoutStartSec

function isBackupRunning(status: ClawKeepStatus | null): boolean {
  if (!status) return false;
  if (status.lastHeartbeatStatus !== "running") return false;
  if (!status.lastHeartbeatAtMs) return false;
  return Date.now() - status.lastHeartbeatAtMs < STALE_RUNNING_MS;
}

interface CloudSnapshot {
  name: string;
  size_bytes: number;
  last_modified_ms: number;
}

interface RestoreResponse {
  ok: true;
  archive: string;
  archiveBytes: number;
  assets: { kind: string; targetPath: string; backupPath: string; bytesRestored: number }[];
  restartErrors: string[];
}

interface PairStartResponse {
  user_code: string;
  verification_url: string;
  interval: number;
  code_length: number;
}

interface PairPollResponse {
  status: "pending" | "configuring" | "complete" | "error";
  error?: string;
}

interface BackupResponse {
  ok: boolean;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

const CARD = "rounded-xl border border-white/10 bg-[var(--bg-deep)]/70 p-4";

function timeAgo(ms: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "in the future";
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function jsonOrError<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export default function ClawKeepApp() {
  const [status, setStatus] = useState<ClawKeepStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "pair" | "backup" | "unpair" | "restore">("");
  const [backupResult, setBackupResult] = useState<BackupResponse | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResponse | null>(null);
  const [pairChallenge, setPairChallenge] = useState<PairStartResponse | null>(null);
  const [pairPhase, setPairPhase] = useState<"" | "pending" | "configuring">("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [confirmPending, setConfirmPending] = useState<{
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await jsonOrError<ClawKeepStatus>(
        await fetch("/setup-api/clawkeep", { cache: "no-store" }),
      );
      setStatus(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll the dashboard every 3s while a backup is in progress. The server
  // is the source of truth, so reopening the window mid-run still picks up
  // the live "running" state and shows the right step.
  useEffect(() => {
    if (!isBackupRunning(status)) return;
    const id = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(id);
  }, [status, refresh]);

  // RFC 8628 device-code poll loop. While pairing is active we hit
  // /pair/poll every `interval` seconds (the upstream's recommended
  // value). Phases: pending → configuring → complete.
  useEffect(() => {
    if (!pairChallenge) return;
    if (pairPhase !== "pending" && pairPhase !== "configuring") return;

    const tick = async () => {
      try {
        const ps = await jsonOrError<PairPollResponse>(
          await fetch("/setup-api/clawkeep/pair/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        if (ps.status === "complete") {
          stopPolling();
          setPairChallenge(null);
          setPairPhase("");
          await refresh();
          return;
        }
        if (ps.status === "configuring") {
          setPairPhase("configuring");
          return;
        }
        if (ps.status === "error") {
          stopPolling();
          setPairChallenge(null);
          setPairPhase("");
          setError(ps.error || "Pair failed");
          return;
        }
        // "pending" — keep polling
      } catch {
        // swallow — next tick retries
      }
    };

    const stopPolling = () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };

    const intervalMs = Math.max(2, pairChallenge.interval) * 1000;
    pollIntervalRef.current = window.setInterval(tick, intervalMs);
    void tick();
    return stopPolling;
  }, [pairChallenge, pairPhase, refresh]);

  const onPair = useCallback(async () => {
    setBusy("pair");
    setError(null);
    try {
      const start = await jsonOrError<PairStartResponse>(
        await fetch("/setup-api/clawkeep/pair/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      setPairChallenge(start);
      setPairPhase("pending");
      window.open(start.verification_url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, []);

  const onCancelPair = useCallback(() => {
    setPairChallenge(null);
    setPairPhase("");
    setError(null);
  }, []);

  const onUnpair = useCallback(() => {
    setConfirmPending({
      title: "Unpair this device?",
      body: (
        <>
          Cloud backups will stop until you pair again. Existing snapshots
          stay on the portal — your local config and tokens are removed.
        </>
      ),
      confirmLabel: "Unpair",
      danger: true,
      onConfirm: async () => {
        setBusy("unpair");
        setError(null);
        try {
          await jsonOrError<{ ok: true }>(
            await fetch("/setup-api/clawkeep/unpair", { method: "POST" }),
          );
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy("");
        }
      },
    });
  }, [refresh]);

  const onBackup = useCallback(async () => {
    setBusy("backup");
    setError(null);
    setBackupResult(null);
    try {
      const result = await jsonOrError<BackupResponse>(
        await fetch("/setup-api/clawkeep/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      setBackupResult(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, [refresh]);

  const onRestore = useCallback(
    (name: string) => {
      // The restore is destructive — we move ~/.openclaw aside and replace
      // it with the snapshot's contents, then bounce the gateway. Route
      // the confirm through our themed dialog instead of window.confirm
      // so the look matches the rest of the app on every browser.
      setConfirmPending({
        title: `Restore "${name}"?`,
        body: (
          <>
            <p>
              This replaces your current OpenClaw state, config, and credentials
              with the snapshot. Your existing state is moved aside to a{" "}
              <code className="text-emerald-300">.bak-restore-*</code> directory
              so it can be recovered manually if needed.
            </p>
            <p className="mt-2 text-[var(--text-muted)]">
              OpenClaw services will restart after the restore completes.
            </p>
          </>
        ),
        confirmLabel: "Restore",
        danger: true,
        onConfirm: async () => {
          setBusy("restore");
          setError(null);
          setRestoreResult(null);
          setRestoreOpen(false);
          try {
            const result = await jsonOrError<RestoreResponse>(
              await fetch("/setup-api/clawkeep/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              }),
            );
            setRestoreResult(result);
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy("");
          }
        },
      });
    },
    [refresh],
  );

  if (!status && !error) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  if (!status) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6">
        <div className={`${CARD} max-w-md text-sm`}>
          <p className="text-red-300">⚠️ Load failed</p>
          {error && <p className="mt-2 text-xs text-[var(--text-muted)]">{error}</p>}
          <button
            type="button"
            onClick={refresh}
            className="mt-3 px-3 py-1.5 rounded-md bg-orange-500 text-white text-xs font-semibold"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto bg-[var(--bg-app)] text-gray-200">
      {status.paired && (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <a
            href={`${status.server}/portal/clawkeep`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2.5 py-1 rounded-md border border-white/10 text-xs text-[var(--text-secondary)] hover:bg-white/5 inline-flex items-center gap-1.5 cursor-pointer"
            title="Manage backups, devices, and billing on the ClawKeep portal"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
              dashboard
            </span>
            Portal
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 12 }} aria-hidden="true">
              open_in_new
            </span>
          </a>
          <button
            type="button"
            disabled={busy === "unpair"}
            onClick={onUnpair}
            className="px-2.5 py-1 rounded-md border border-white/10 text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 cursor-pointer"
          >
            {busy === "unpair" ? "🔌 Unpairing…" : "Unpair"}
          </button>
        </div>
      )}

      <div className="min-h-full w-full flex items-center justify-center p-6">
        <div className="w-full max-w-2xl space-y-4">
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              ⚠️ {error}
            </div>
          )}

          {pairChallenge ? (
            <PairChallengeCard
              challenge={pairChallenge}
              phase={pairPhase}
              onCancel={onCancelPair}
            />
          ) : status.paired ? (
            <>
              <DashboardCard
                status={status}
                onBackup={onBackup}
                onOpenRestore={() => setRestoreOpen(true)}
                // A running daemon is its own kind of busy — keep showing the
                // progress panel even if the user closes and reopens the window
                // mid-run. The local `busy` flag is only authoritative right
                // after a click, before the daemon has heartbeat-published its
                // "running" state.
                busyKind={
                  busy === "restore"
                    ? "restore"
                    : busy === "backup" || isBackupRunning(status)
                    ? "backup"
                    : null
                }
              />
              <ScheduleCard
                schedule={status.schedule}
                nextRunAtMs={status.nextRunAtMs}
                onSaved={(next) => {
                  setStatus((prev) => prev ? { ...prev, schedule: next.schedule, nextRunAtMs: next.nextRunAtMs } : prev);
                }}
                onError={setError}
              />
            </>
          ) : (
            <PairCard onPair={onPair} busy={busy === "pair"} />
          )}

          {(!status.openclawInstalled || !status.daemonInstalled) && <SystemCard status={status} />}

          {backupResult && <BackupResultCard result={backupResult} />}
          {restoreResult && <RestoreResultCard result={restoreResult} />}

          {restoreOpen && (
            <RestoreModal
              onClose={() => setRestoreOpen(false)}
              onPick={(name) => onRestore(name)}
              onError={setError}
            />
          )}
        </div>
      </div>

      {confirmPending && (
        <ConfirmDialog
          title={confirmPending.title}
          body={confirmPending.body}
          confirmLabel={confirmPending.confirmLabel}
          danger={confirmPending.danger}
          onCancel={() => setConfirmPending(null)}
          onConfirm={() => {
            const fn = confirmPending.onConfirm;
            setConfirmPending(null);
            void fn();
          }}
        />
      )}
    </div>
  );
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatNextRun(ms: number): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return "any moment";
  const totalMin = Math.round(diff / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function ScheduleCard({
  schedule,
  nextRunAtMs,
  onSaved,
  onError,
}: {
  schedule: ClawKeepSchedule;
  nextRunAtMs: number;
  onSaved: (next: { schedule: ClawKeepSchedule; nextRunAtMs: number }) => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<ClawKeepSchedule>(schedule);
  const [saving, setSaving] = useState(false);
  // Re-sync the draft when the parent re-fetches (e.g. after a backup run
  // bumped nextRunAtMs server-side).
  useEffect(() => { setDraft(schedule); }, [schedule]);

  const dirty =
    draft.enabled !== schedule.enabled
    || draft.frequency !== schedule.frequency
    || draft.timeOfDay !== schedule.timeOfDay
    || draft.weekday !== schedule.weekday;

  const save = async (override?: ClawKeepSchedule) => {
    const payload = override ?? draft;
    setSaving(true);
    try {
      const body = await jsonOrError<{ schedule: ClawKeepSchedule; nextRunAtMs: number }>(
        await fetch("/setup-api/clawkeep/schedule", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      setDraft(body.schedule);
      onSaved(body);
    } catch (e) {
      onError(`Could not save schedule: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${CARD} space-y-4`}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">Auto-backup</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {draft.enabled
              ? `Next run ${formatNextRun(nextRunAtMs)}`
              : "Off — back up only when you click Back up now."}
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={draft.enabled}
            disabled={saving}
            onChange={(e) => {
              const next = { ...draft, enabled: e.target.checked };
              setDraft(next);
              void save(next);
            }}
          />
          <span className="w-10 h-6 bg-white/10 rounded-full peer-checked:bg-emerald-500 transition-colors" />
          <span className="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
        </label>
      </div>

      {draft.enabled && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {(["daily", "weekly"] as const).map((freq) => (
              <button
                key={freq}
                type="button"
                onClick={() => setDraft((d) => ({ ...d, frequency: freq }))}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                  draft.frequency === freq
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                    : "border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                }`}
              >
                {freq === "daily" ? "Daily" : "Weekly"}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs text-[var(--text-muted)] w-16">Time</label>
            <input
              type="time"
              value={draft.timeOfDay}
              onChange={(e) => setDraft((d) => ({ ...d, timeOfDay: e.target.value }))}
              className="px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-white/10 text-sm text-gray-200 focus:outline-none focus:border-emerald-500/50"
            />
            <span className="text-xs text-[var(--text-muted)]">device-local</span>
          </div>

          {draft.frequency === "weekly" && (
            <div className="flex items-center gap-3">
              <label className="text-xs text-[var(--text-muted)] w-16">Day</label>
              <div className="flex gap-1 flex-wrap">
                {WEEKDAY_LABELS.map((label, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, weekday: idx }))}
                    className={`px-2.5 py-1 rounded-md text-xs border cursor-pointer ${
                      draft.weekday === idx
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                        : "border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {dirty && (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={saving}
                onClick={() => save()}
                className="px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-50 cursor-pointer"
              >
                {saving ? "Saving…" : "Save schedule"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Esc closes via a global listener (the dialog itself doesn't focus a
  // text input, so an inline onKeyDown wouldn't fire reliably). Enter is
  // handled by whichever button has focus — autoFocus puts it on Confirm
  // but tabbing to Cancel and pressing Enter must cancel, not confirm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const confirmClasses = danger
    ? "bg-red-500 hover:bg-red-400 text-white"
    : "bg-emerald-500 hover:bg-emerald-400 text-black";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clawkeep-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[var(--bg-deep)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <div
            className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
              danger ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"
            }`}
            aria-hidden="true"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 22 }}>
              {danger ? "warning" : "help"}
            </span>
          </div>
          <h2 id="clawkeep-confirm-title" className="text-base font-semibold text-gray-100 break-words">
            {title}
          </h2>
        </div>
        <div className="px-5 pt-3 pb-4 text-sm leading-relaxed text-[var(--text-secondary)]">
          {body}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5 pt-2 border-t border-white/5">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-white/10 text-gray-200 hover:bg-white/5 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={`px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PairCard({ onPair, busy }: { onPair: () => void; busy: boolean }) {
  return (
    <div
      className={`${CARD} relative overflow-hidden flex flex-col items-center text-center px-6 pt-12 pb-8`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-80 h-80 bg-[radial-gradient(circle,rgba(249,115,22,0.4),transparent_70%)] blur-3xl opacity-70"
      />
      <div className="relative w-44 h-44 flex items-center justify-center mb-4">
        <div
          aria-hidden="true"
          className="clawkeep-shield-ring absolute inset-0 rounded-full border-2 border-orange-400/60 bg-orange-500/10"
        />
        <div
          aria-hidden="true"
          className="clawkeep-shield-ring-delayed absolute inset-0 rounded-full border-2 border-orange-400/60 bg-orange-500/10"
        />
        <div className="clawkeep-shield-breathe relative w-32 h-32 rounded-full flex items-center justify-center bg-gradient-to-br from-orange-400 via-orange-500 to-amber-600 shadow-[0_0_60px_rgba(249,115,22,0.45)]">
          <span
            className="material-symbols-rounded text-white drop-shadow-[0_0_10px_rgba(249,115,22,0.55)]"
            style={{ fontSize: 76, fontVariationSettings: "'FILL' 1, 'wght' 600" }}
            aria-hidden="true"
          >
            shield_lock
          </span>
        </div>
      </div>
      <h2 className="relative text-3xl font-bold font-display">Pair this device</h2>
      <p className="relative mt-1.5 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
        Link this OpenClaw to your portal account and we&apos;ll mint short-lived
        R2 credentials so every backup lands in your private prefix.
      </p>
      <button
        type="button"
        onClick={onPair}
        disabled={busy}
        className="relative mt-7 px-6 py-2.5 rounded-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-sm font-semibold shadow-lg cursor-pointer"
      >
        {busy ? "🔗 Connecting…" : "Pair with portal"}
      </button>
    </div>
  );
}

function PairChallengeCard({
  challenge,
  phase,
  onCancel,
}: {
  challenge: PairStartResponse;
  phase: "" | "pending" | "configuring";
  onCancel: () => void;
}) {
  const code = challenge.user_code;
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }, []);

  // Auto-copy when a fresh code lands. Mirrors what the user just told the
  // portal to expect — they can paste straight into the portal field
  // without re-typing. Re-runs only when the code itself changes so a
  // re-render (e.g. phase transition) doesn't keep stomping the clipboard.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void copyToClipboard(code).then((ok) => {
      if (!cancelled && ok) flashCopied();
    });
    return () => {
      cancelled = true;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [code, flashCopied]);

  const onCopyClick = useCallback(async () => {
    const ok = await copyToClipboard(code);
    if (ok) flashCopied();
  }, [code, flashCopied]);

  return (
    <div className={`${CARD} space-y-4`}>
      <h2 className="font-semibold">
        {phase === "configuring" ? "🔄 Configuring…" : "👉 Enter this code"}
      </h2>
      <div className="flex items-center justify-center gap-2 py-2">
        <span
          className="select-all cursor-text px-4 py-2 rounded-lg bg-black/40 border border-white/10 font-mono text-2xl tracking-[0.2em] text-orange-200"
          aria-label="Pairing code"
        >
          {code}
        </span>
        <button
          type="button"
          onClick={onCopyClick}
          aria-label={copied ? "Code copied" : "Copy code"}
          className="px-2.5 py-2 rounded-md text-xs font-medium text-orange-300 bg-black/30 border border-white/10 hover:bg-black/50 cursor-pointer transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] text-center">
        On the portal page that opened, type the code and approve.
      </p>
      <div className="flex justify-center gap-2">
        <a
          href={challenge.verification_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-orange-300 hover:text-orange-200 underline"
        >
          Re-open portal page
        </a>
        <span className="text-xs text-[var(--text-muted)]">·</span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-[var(--text-muted)] hover:text-gray-200"
        >
          Cancel
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)] text-center">
        {phase === "configuring" ? "⏳ Saving token…" : "🕒 Waiting for approval…"}
      </p>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function BackupProgressPanel({
  kind = "backup",
  startedAtMs,
  stepLabel: explicitStepLabel,
}: {
  kind?: "backup" | "restore";
  /** Server-anchored start time (ms). Anchoring elapsed to the daemon's
   *  heartbeat means a reopened window shows "1:42" instead of "0:00". */
  startedAtMs?: number;
  /** Friendly label for the daemon's current sub-phase (backup only). */
  stepLabel?: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    // All `Date.now()` reads are inside the effect so render stays pure.
    const startMs = startedAtMs && startedAtMs > 0 ? startedAtMs : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs]);

  const isBackup = kind === "backup";
  const fallback = isBackup
    ? "Building the openclaw archive and uploading to your prefix. This can take a few minutes."
    : "Downloading the snapshot, verifying it, and swapping it into place. OpenClaw services restart at the end.";
  const stepLabel = explicitStepLabel || fallback;

  // Backup = green (we're actively protecting). Restore = orange (recovery
  // in flight). Keeping the two visually distinct so the user can tell at
  // a glance which long-running op they're watching.
  const palette = isBackup
    ? {
        border: "border-emerald-400/30",
        gradient: "from-emerald-500/10 via-emerald-500/5",
        spinnerRing: "border-emerald-400/30 border-t-emerald-400",
        text: "text-emerald-100",
        track: "bg-emerald-500/15",
        bar: "bg-emerald-400",
        ariaLabel: "Backup in progress",
      }
    : {
        border: "border-orange-400/30",
        gradient: "from-orange-500/10 via-orange-500/5",
        spinnerRing: "border-orange-400/30 border-t-orange-400",
        text: "text-orange-100",
        track: "bg-orange-500/15",
        bar: "bg-orange-400",
        ariaLabel: "Restore in progress",
      };

  return (
    <div className={`rounded-xl border ${palette.border} bg-gradient-to-br ${palette.gradient} to-transparent p-6`}>
      <div className="flex items-center gap-4">
        <div
          aria-hidden="true"
          className={`shrink-0 w-12 h-12 rounded-full border-4 ${palette.spinnerRing} animate-spin`}
        />
        <div className="flex-1 min-w-0">
          <div className={`text-base font-semibold ${palette.text}`}>
            {isBackup ? "Protecting your OpenClaw…" : "Restoring from ClawBox cloud…"}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {stepLabel}
          </div>
        </div>
        <div
          className={`shrink-0 text-2xl font-mono font-semibold ${palette.text} tabular-nums`}
          aria-label="Elapsed time"
        >
          {formatElapsed(elapsed)}
        </div>
      </div>
      <div
        className={`mt-4 h-1.5 rounded-full ${palette.track} overflow-hidden`}
        role="progressbar"
        aria-label={palette.ariaLabel}
      >
        <div
          className={`h-full rounded-full ${palette.bar}`}
          style={{ animation: "indeterminate 1.6s ease-in-out infinite" }}
        />
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        {isBackup
          ? "Safe to close — the backup keeps running on the device. Reopen ClawKeep any time to see the result."
          : "Don't power off the device until this finishes — the on-disk swap should not be interrupted mid-flight."}
      </p>
    </div>
  );
}

type ProtectionState = "protected" | "lapsed" | "unprotected";

function deriveProtection(status: ClawKeepStatus): ProtectionState {
  if (status.lastHeartbeatStatus === "error") return "lapsed";
  if (status.lastBackupAtMs > 0) return "protected";
  return "unprotected";
}

interface ProtectionCopy {
  headline: string;
  subhead: string;
  badge: string;
  iconName: string;
  badgeClass: string;
  haloClass: string;
  ringClass: string;
  discClass: string;
  iconClass: string;
  primaryClass: string;
}

// Lapsed and unprotected share an "at-risk" red palette; only headline/
// subhead/icon/badge differ. Spread a single base into both.
const RED_PALETTE = {
  badgeClass: "bg-red-500/15 text-red-300 border-red-500/30",
  haloClass: "bg-[radial-gradient(circle,rgba(239,68,68,0.45),transparent_70%)]",
  ringClass: "border-red-400/60 bg-red-500/10",
  discClass:
    "bg-gradient-to-br from-red-400 via-red-500 to-rose-600 shadow-[0_0_60px_rgba(239,68,68,0.45)]",
  iconClass: "text-white drop-shadow-[0_0_10px_rgba(239,68,68,0.55)]",
  primaryClass: "bg-red-500 hover:bg-red-400",
} as const;

const COPY_BY_STATE: Record<ProtectionState, ProtectionCopy> = {
  protected: {
    headline: "You're Protected",
    subhead: "Your OpenClaw is safe in the ClawBox cloud — config, agents, credentials, the works.",
    badge: "PROTECTED",
    iconName: "verified_user",
    badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    haloClass: "bg-[radial-gradient(circle,rgba(16,185,129,0.45),transparent_70%)]",
    ringClass: "border-emerald-400/60 bg-emerald-500/10",
    discClass:
      "bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_60px_rgba(16,185,129,0.45)]",
    iconClass: "text-white drop-shadow-[0_0_10px_rgba(16,185,129,0.55)]",
    primaryClass: "bg-emerald-500 hover:bg-emerald-400",
  },
  lapsed: {
    ...RED_PALETTE,
    headline: "Protection Lapsed",
    subhead: "Your last backup didn't complete. One retry and we'll lock it back down.",
    badge: "AT RISK",
    iconName: "gpp_maybe",
  },
  unprotected: {
    ...RED_PALETTE,
    headline: "Not Protected",
    subhead:
      "One click and your OpenClaw is locked safely in the ClawBox cloud. Config, agents, credentials — sleep easy.",
    badge: "UNPROTECTED",
    iconName: "gpp_bad",
  },
};

function DashboardCard({
  status,
  onBackup,
  onOpenRestore,
  busyKind,
}: {
  status: ClawKeepStatus;
  onBackup: () => void;
  onOpenRestore: () => void;
  busyKind: "backup" | "restore" | null;
}) {
  if (busyKind) {
    // Only anchor the elapsed counter to the daemon's heartbeat when the
    // status is *currently* "running" — otherwise we'd read the previous
    // run's "ok" timestamp (which can be hours old) and show 84:00 the
    // instant the user clicks Back up now, before the new run has
    // published its first "running" heartbeat.
    const startedAtMs =
      busyKind === "backup" && status.lastHeartbeatStatus === "running"
        ? status.lastHeartbeatAtMs
        : undefined;
    return (
      <BackupProgressPanel
        kind={busyKind}
        startedAtMs={startedAtMs}
        stepLabel={busyKind === "backup" ? STEP_LABELS[status.currentStep] : undefined}
      />
    );
  }

  const disabled = !status.daemonInstalled || !status.openclawInstalled;
  // No snapshots → restore nothing. Hide rather than offer an action that's
  // guaranteed to be empty.
  const canRestore = !disabled && status.snapshotCount > 0;

  const state = deriveProtection(status);
  const copy = COPY_BY_STATE[state];

  return (
    <div
      className={`${CARD} relative overflow-hidden flex flex-col items-center text-center px-6 pt-12 pb-8`}
    >
      {/* Status badge top-right — small, clean, antivirus-style */}
      <div
        className={`absolute top-3 right-3 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wider ${copy.badgeClass}`}
      >
        {copy.badge}
      </div>

      {/* Halo glow behind the shield */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-80 h-80 ${copy.haloClass} blur-3xl opacity-70`}
      />

      {/* The shield itself */}
      <div className="relative w-44 h-44 flex items-center justify-center mb-4">
        {/* Two outward-radiating rings — staggered so a wave is always mid-flight */}
        <div
          aria-hidden="true"
          className={`clawkeep-shield-ring absolute inset-0 rounded-full border-2 ${copy.ringClass}`}
        />
        <div
          aria-hidden="true"
          className={`clawkeep-shield-ring-delayed absolute inset-0 rounded-full border-2 ${copy.ringClass}`}
        />
        {/* Solid disc with a slow breathe */}
        <div
          className={`clawkeep-shield-breathe relative w-32 h-32 rounded-full flex items-center justify-center ${copy.discClass}`}
        >
          <span
            className={`material-symbols-rounded ${copy.iconClass}`}
            style={{ fontSize: 76, fontVariationSettings: "'FILL' 1, 'wght' 600, 'GRAD' 0" }}
            aria-hidden="true"
          >
            {copy.iconName}
          </span>
        </div>
      </div>

      <h2 className="relative text-3xl font-bold font-display mt-2">{copy.headline}</h2>
      <p className="relative mt-1.5 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
        {copy.subhead}
      </p>

      {/* Stats strip — compact, equal-width, no card chrome to keep the eye on the shield */}
      <div className="relative mt-6 grid grid-cols-3 gap-6 w-full max-w-md text-center">
        <Stat label="Last backup" value={timeAgo(status.lastBackupAtMs)} />
        <Stat label="Cloud usage" value={formatBytes(status.cloudBytes)} />
        <Stat label="Snapshots" value={status.snapshotCount.toString()} />
      </div>

      {/* Action row */}
      <div className="relative mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onBackup}
          disabled={disabled}
          className={`px-6 py-2.5 rounded-full ${copy.primaryClass} disabled:opacity-50 text-white text-sm font-semibold shadow-lg transition-colors cursor-pointer`}
        >
          {state === "protected" ? "Back up now" : "Protect my OpenClaw"}
        </button>
        {canRestore && (
          <button
            type="button"
            onClick={onOpenRestore}
            className="px-6 py-2.5 rounded-full border border-white/15 bg-white/[0.04] text-sm font-semibold text-gray-200 hover:bg-white/[0.08] hover:border-white/25 transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
              cloud_download
            </span>
            Restore from snapshot
          </button>
        )}
      </div>
    </div>
  );
}

function SystemCard({ status }: { status: ClawKeepStatus }) {
  return (
    <div className={`${CARD} space-y-2 border-amber-500/20 bg-amber-500/5`}>
      <h2 className="font-semibold text-amber-200">⚙️ Setup needed</h2>
      <ul className="text-sm text-amber-100 space-y-1">
        {!status.openclawInstalled && (
          <li>
            <code className="bg-black/30 px-1 rounded">openclaw</code> is not on $PATH. Install with{" "}
            <code className="bg-black/30 px-1 rounded">npm install -g openclaw</code>.
          </li>
        )}
        {!status.daemonInstalled && (
          <li>
            <code className="bg-black/30 px-1 rounded">clawkeepd</code> is not on $PATH. From{" "}
            <code className="bg-black/30 px-1 rounded">clawbox/clawkeep</code> run{" "}
            <code className="bg-black/30 px-1 rounded">pip install --user .</code>.
          </li>
        )}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  // Wrapper div is load-bearing — each `<Stat>` is one cell of a 3-col grid.
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-base font-semibold text-gray-100 truncate">{value}</div>
    </div>
  );
}

function BackupResultCard({ result }: { result: BackupResponse }) {
  const tail = result.stderrTail || result.stdoutTail || "(no output)";
  return (
    <div
      className={`${CARD} ${
        result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <h2 className="font-semibold">
        {result.ok ? "✅ Backup ok" : `❌ Failed (exit ${result.exitCode})`}
      </h2>
      <pre className="mt-2 text-[11px] font-mono text-gray-200/90 whitespace-pre-wrap max-h-48 overflow-auto bg-black/30 p-2 rounded">
        {tail}
      </pre>
    </div>
  );
}

function RestoreResultCard({ result }: { result: RestoreResponse }) {
  return (
    <div className={`${CARD} border-emerald-500/30 bg-emerald-500/5 space-y-2`}>
      <h2 className="font-semibold">✅ Restore ok</h2>
      <p className="text-sm text-[var(--text-muted)]">
        Restored <code className="bg-black/30 px-1 rounded">{result.archive}</code>{" "}
        ({formatBytes(result.archiveBytes)}).
      </p>
      <ul className="text-xs space-y-1">
        {result.assets.map((a) => (
          <li key={a.targetPath} className="text-gray-300">
            <span className="font-mono">{a.targetPath}</span>{" "}
            <span className="text-[var(--text-muted)]">
              ({formatBytes(a.bytesRestored)} — previous version preserved at{" "}
              <span className="font-mono">{a.backupPath}</span>)
            </span>
          </li>
        ))}
      </ul>
      {result.restartErrors.length > 0 && (
        <p className="text-xs text-amber-300">
          ⚠️ Could not auto-restart {result.restartErrors.length} service(s). Run{" "}
          <code className="bg-black/30 px-1 rounded">sudo systemctl restart clawbox-gateway</code>{" "}
          manually.
        </p>
      )}
    </div>
  );
}

// Parse the timestamp embedded in `<2026-04-29T09-37-13.020Z>-openclaw-backup.tar.gz`
// into a friendly display. Falls back to the raw name if the format ever
// changes — better than crashing the modal over a regex miss.
function parseSnapshotName(name: string): { date: string; time: string; raw: string } | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.\d+Z-/);
  if (!m) return null;
  const [, y, mo, d, h, min] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +min));
  if (Number.isNaN(dt.getTime())) return null;
  return {
    date: dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    time: dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    raw: name,
  };
}

function RestoreModal({
  onClose,
  onPick,
  onError,
}: {
  onClose: () => void;
  onPick: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<CloudSnapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Pin the callbacks to refs so the fetch effect doesn't refire when the
  // parent passes inline arrows that change identity on every render.
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await jsonOrError<{ snapshots: CloudSnapshot[] }>(
          await fetch("/setup-api/clawkeep/snapshots", { cache: "no-store" }),
        );
        if (!cancelled) setSnapshots(data.snapshots);
      } catch (e) {
        if (!cancelled) {
          onErrorRef.current((e as Error).message);
          onCloseRef.current();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc closes the modal — basic dialog hygiene; the click-on-backdrop
  // handler covers the mouse path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Restore from cloud snapshot"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="relative px-6 pt-6 pb-4 border-b border-white/5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-16 -right-16 w-56 h-56 bg-[radial-gradient(circle,rgba(16,185,129,0.18),transparent_70%)] blur-2xl"
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <span
                  className="material-symbols-rounded text-emerald-400"
                  style={{ fontSize: 22, fontVariationSettings: "'FILL' 1" }}
                  aria-hidden="true"
                >
                  cloud_download
                </span>
              </div>
              <div>
                <h2 className="text-lg font-semibold leading-tight">Restore from snapshot</h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Roll back to any cloud backup. Your current state is moved aside, not deleted.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-white/5 hover:text-gray-100 cursor-pointer"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }} aria-hidden="true">
                close
              </span>
            </button>
          </div>
        </header>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading && (
            <div className="py-12 flex flex-col items-center gap-3 text-sm text-[var(--text-muted)]">
              <div
                aria-hidden="true"
                className="w-8 h-8 rounded-full border-2 border-white/10 border-t-emerald-400 animate-spin"
              />
              <span>Fetching snapshots from your prefix…</span>
            </div>
          )}

          {!loading && snapshots && snapshots.length === 0 && (
            <div className="py-12 text-center text-sm text-[var(--text-muted)]">
              <span
                className="material-symbols-rounded block mx-auto mb-2 text-[var(--text-muted)]/60"
                style={{ fontSize: 32 }}
                aria-hidden="true"
              >
                cloud_off
              </span>
              No snapshots in your prefix yet. Run a backup first.
            </div>
          )}

          {!loading && snapshots && snapshots.length > 0 && (
            <ul className="space-y-2">
              {snapshots.map((s, idx) => {
                const parsed = parseSnapshotName(s.name);
                const newest = idx === 0;
                return (
                  <li key={s.name}>
                    <button
                      type="button"
                      onClick={() => onPick(s.name)}
                      className="group w-full text-left rounded-xl border border-white/10 bg-white/[0.02] hover:bg-emerald-500/[0.08] hover:border-emerald-500/40 px-4 py-3 cursor-pointer transition-colors flex items-center gap-3"
                    >
                      <div className="shrink-0 w-10 h-10 rounded-lg bg-white/[0.04] group-hover:bg-emerald-500/15 border border-white/5 group-hover:border-emerald-500/30 flex items-center justify-center transition-colors">
                        <span
                          className="material-symbols-rounded text-[var(--text-muted)] group-hover:text-emerald-300"
                          style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
                          aria-hidden="true"
                        >
                          inventory_2
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-100 truncate">
                            {parsed ? `${parsed.date} · ${parsed.time}` : s.name}
                          </span>
                          {newest && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[9px] font-bold tracking-wider border border-emerald-500/30">
                              LATEST
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[var(--text-muted)] flex items-center gap-2">
                          <span>{formatBytes(s.size_bytes)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{timeAgo(s.last_modified_ms)}</span>
                        </div>
                      </div>
                      <span
                        className="shrink-0 material-symbols-rounded text-[var(--text-muted)]/50 group-hover:text-emerald-400 transition-colors"
                        style={{ fontSize: 18 }}
                        aria-hidden="true"
                      >
                        chevron_right
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-white/5 bg-white/[0.02] text-[11px] text-[var(--text-muted)] flex items-center gap-2">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
            info
          </span>
          <span>
            Restoring overwrites your live state. Current state is preserved at{" "}
            <code className="bg-black/40 px-1 rounded">~/.openclaw.bak-restore-*</code>.
          </span>
        </footer>
      </div>
    </div>
  );
}
