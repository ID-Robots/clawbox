"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { useClawboxLogin } from "@/lib/use-clawbox-login";
import FreeTierUpgradeCard from "./FreeTierUpgradeCard";

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
  uploadBytesTotal: number;
  uploadBytesDone: number;
  uploadStartedAtMs: number;
  openclawInstalled: boolean;
  daemonInstalled: boolean;
  schedule: ClawKeepSchedule;
  nextRunAtMs: number;
  /** True when the device has a stored backup-encryption passphrase. The
   * "Run a backup now" button is gated on this; without it the runner
   * refuses to run since unencrypted backups would leak to the operator. */
  encryptionConfigured: boolean;
}

// Map the daemon's phase id to an i18n key for the progress panel.
// Keys must match clawkeep/clawkeep/runner.py: STEP_* constants — keep in
// lockstep when adding/renaming phases. The values resolve to translated
// labels at render time via t().
const STEP_LABEL_KEYS: Record<string, string> = {
  starting: "clawkeep.step.starting",
  archiving: "clawkeep.step.archiving",
  encrypting: "clawkeep.step.encrypting",
  uploading: "clawkeep.step.uploading",
  "checking-stats": "clawkeep.step.checkingStats",
};

// If a "running" status hasn't been refreshed in this many ms, assume the
// daemon crashed (systemd timer kill, OOM, …) and stop showing the
// progress panel — otherwise reopens would spin forever after a fault.
//
// Real backups on Jetson finish in 2-5 minutes (archive build + upload to
// R2 over a typical home connection). 30 minutes is a comfortable upper
// bound — a backup that genuinely takes longer almost always means the
// upload is stuck, in which case the user wants the "Reset stuck backup"
// affordance below, not a 4-hour spinner that pretends progress is fine.
const STALE_RUNNING_MS = 30 * 60 * 1000;
// Show a "Looks stuck?" reset button after this much wall-clock time on
// the same heartbeat. Tighter than STALE_RUNNING_MS so the user has a
// recovery path *before* the panel auto-hides.
const RESET_HINT_AFTER_MS = 6 * 60 * 1000;

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

type Translator = (key: string, params?: Record<string, string | number>) => string;

function timeAgo(ms: number, t: Translator): string {
  if (!ms) return t("clawkeep.never");
  const diff = Date.now() - ms;
  if (diff < 0) return t("clawkeep.inFuture");
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return t("clawkeep.justNow");
  if (minutes < 60) return t("clawkeep.minutesAgo", { count: minutes });
  if (hours < 24) return t("clawkeep.hoursAgo", { count: hours });
  return t("clawkeep.daysAgo", { count: days });
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
  const { t } = useT();
  // Per-feature ClawBox-AI gating lives inside the ClawKeep app itself
  // (e.g. the Cloud mode shows "Connect ClawBox AI first" inline). An
  // outer full-app login gate was tried and removed — it duplicated the
  // inline UX and broke local-only flows where ClawBox AI isn't required.
  const [status, setStatus] = useState<ClawKeepStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "pair" | "backup" | "unpair" | "restore">("");
  const [backupResult, setBackupResult] = useState<BackupResponse | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResponse | null>(null);
  const [pairChallenge, setPairChallenge] = useState<PairStartResponse | null>(null);
  const [pairPhase, setPairPhase] = useState<"" | "pending" | "configuring">("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Set-passphrase modal — shown either as a one-shot before the first
  // backup (if the user hasn't configured encryption yet) or via an
  // explicit "Change encryption passphrase" button. The pending action
  // is what we run after the passphrase is saved and status refetched.
  const [passphraseSetup, setPassphraseSetup] = useState<{
    onSaved?: () => void;
  } | null>(null);
  // Restore-passphrase modal — shown when the daemon reports the archive
  // needs a passphrase the device doesn't currently have stored, or when
  // a previous attempt's passphrase was wrong. We retain the snapshot
  // name so the user can retry without picking from the list again.
  const [restorePassphrase, setRestorePassphrase] = useState<{
    name: string;
    error?: string;
  } | null>(null);
  const [confirmPending, setConfirmPending] = useState<{
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  // ClawBox-AI tier drives the Free-user upgrade card. Portal also gates
  // upload/repo endpoints with `clawkeepQuotaBytes <= 0 → 403`, but
  // surfacing it here avoids a click that would silently bounce. While
  // `loading` is true we render nothing to prevent flicker between
  // PairCard (paid path) and FreeTierUpgradeCard (Free path).
  const { tier: clawaiTier, loading: clawaiLoading } = useClawboxLogin();
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
          setError(ps.error || t("clawkeep.pair.failed"));
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
      title: t("clawkeep.confirm.unpairTitle"),
      body: <>{t("clawkeep.confirm.unpairBody")}</>,
      confirmLabel: t("clawkeep.unpairButton"),
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
  }, [refresh, t]);

  const runBackupNow = useCallback(async () => {
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

  const onResetStuck = useCallback(() => {
    // Surface a dire-warning confirm because a stuck heartbeat *might*
    // still be a slow-but-real upload — clearing the spinner doesn't
    // kill the underlying clawkeepd process, but it does hide its
    // progress signal until the next status poll, which can confuse
    // someone watching a 100MB+ upload over a flaky link.
    setConfirmPending({
      title: t("clawkeep.confirm.resetStuckTitle"),
      body: <>{t("clawkeep.confirm.resetStuckBody")}</>,
      confirmLabel: t("clawkeep.confirm.resetStuckButton"),
      onConfirm: async () => {
        try {
          await jsonOrError<{ ok: true }>(
            await fetch("/setup-api/clawkeep/reset-state", { method: "POST" }),
          );
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        }
      },
    });
  }, [refresh, t]);

  const onBackup = useCallback(async () => {
    // First-backup gate: encryption must be configured before we let the
    // runner upload anything. Without a device-local passphrase the runner
    // exits early with NEED_PASSPHRASE, but we'd rather surface that as a
    // friendly modal than as a red error banner.
    if (!status?.encryptionConfigured) {
      setPassphraseSetup({ onSaved: () => { void runBackupNow(); } });
      return;
    }
    void runBackupNow();
  }, [status?.encryptionConfigured, runBackupNow]);

  // Inner restore call shared between the regular confirm flow and the
  // password-prompt retry path. Returns true on full success so the
  // caller knows whether to close its modal.
  const performRestore = useCallback(
    async (name: string, passphrase?: string): Promise<{ ok: boolean; needsPassphrase?: boolean; wrong?: boolean }> => {  // eslint-disable-line @typescript-eslint/no-shadow
      setBusy("restore");
      setError(null);
      setRestoreResult(null);
      try {
        const res = await fetch("/setup-api/clawkeep/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(passphrase ? { name, passphrase } : { name }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            needsPassphrase?: boolean;
            kind?: "wrong_password" | "passphrase_missing";
          };
          if (body.needsPassphrase) {
            return {
              ok: false,
              needsPassphrase: true,
              wrong: body.kind === "wrong_password",
            };
          }
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const result = (await res.json()) as RestoreResponse;
        setRestoreResult(result);
        await refresh();
        return { ok: true };
      } catch (e) {
        setError((e as Error).message);
        return { ok: false };
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  const onRestore = useCallback(
    (name: string) => {
      // The restore is destructive — we move ~/.openclaw aside and replace
      // it with the snapshot's contents, then bounce the gateway. Route
      // the confirm through our themed dialog instead of window.confirm
      // so the look matches the rest of the app on every browser.
      setConfirmPending({
        title: t("clawkeep.confirm.restoreTitle", { name }),
        body: (
          <>
            <p>{t("clawkeep.confirm.restoreBody1")}</p>
            <p className="mt-2 text-[var(--text-muted)]">
              {t("clawkeep.confirm.restoreBody2")}
            </p>
          </>
        ),
        confirmLabel: t("clawkeep.restoreButton"),
        danger: true,
        onConfirm: async () => {
          setRestoreOpen(false);
          const outcome = await performRestore(name);
          if (outcome.needsPassphrase) {
            // Open the password prompt modal — the user types their
            // passphrase, we retry with it, and only on success do we
            // show the result card. `wrong` flag pre-fills the error
            // copy so the user understands a previous attempt mismatched.
            setRestorePassphrase({
              name,
              error: outcome.wrong
                ? t("clawkeep.encryption.wrongPassphrase")
                : undefined,
            });
          }
        },
      });
    },
    [performRestore, t],
  );

  if (!status && !error) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[var(--text-muted)]">
        {t("clawkeep.loading")}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6">
        <div className={`${CARD} max-w-md text-sm`}>
          <p className="text-red-300">⚠️ {t("clawkeep.loadFailed")}</p>
          {error && <p className="mt-2 text-xs text-[var(--text-muted)]">{error}</p>}
          <button
            type="button"
            onClick={refresh}
            className="mt-3 px-3 py-1.5 rounded-md bg-orange-500 text-white text-xs font-semibold"
          >
            {t("clawkeep.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto bg-[var(--bg-app)] text-gray-200">
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
                onResetStuck={onResetStuck}
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
              <div className="flex gap-2">
                <a
                  href={`${status.server}/portal/clawkeep`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-white/10 bg-white/[0.03] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] hover:border-white/20 transition-colors cursor-pointer"
                  title={t("clawkeep.portalTitle")}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">dashboard</span>
                  <span className="font-medium">{t("clawkeep.portal")}</span>
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
                </a>
                <button
                  type="button"
                  disabled={busy === "unpair"}
                  onClick={onUnpair}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] text-sm text-red-300/80 hover:text-red-200 hover:bg-red-500/10 hover:border-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">link_off</span>
                  <span className="font-medium">{busy === "unpair" ? t("clawkeep.unpairing") : t("clawkeep.unpairButton")}</span>
                </button>
              </div>
            </>
          ) : clawaiLoading ? null : clawaiTier === null ? (
            <FreeTierUpgradeCard
              featureName="ClawKeep cloud backups"
              description="ClawKeep encrypts your ClawBox data and syncs it to your portal account. Pro plan gets 5 GB; Max plan gets 50 GB."
            />
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

      {passphraseSetup && (
        <SetPassphraseModal
          onCancel={() => setPassphraseSetup(null)}
          onSaved={async () => {
            const next = passphraseSetup.onSaved;
            setPassphraseSetup(null);
            await refresh();
            if (next) next();
          }}
          onError={setError}
        />
      )}

      {restorePassphrase && (
        <RestorePassphraseModal
          name={restorePassphrase.name}
          initialError={restorePassphrase.error}
          onCancel={() => setRestorePassphrase(null)}
          onSubmit={async (pw) => {
            const outcome = await performRestore(restorePassphrase.name, pw);
            if (outcome.ok) {
              setRestorePassphrase(null);
              return { ok: true };
            }
            // Wrong passphrase → keep the modal open with an inline error
            // so the user can re-type without picking the snapshot again.
            return {
              ok: false,
              error: outcome.wrong
                ? t("clawkeep.encryption.wrongPassphrase")
                : t("clawkeep.encryption.restoreFailed"),
            };
          }}
        />
      )}
    </div>
  );
}

const WEEKDAY_LABEL_KEYS = [
  "clawkeep.weekday.sun",
  "clawkeep.weekday.mon",
  "clawkeep.weekday.tue",
  "clawkeep.weekday.wed",
  "clawkeep.weekday.thu",
  "clawkeep.weekday.fri",
  "clawkeep.weekday.sat",
];

function formatNextRun(ms: number, t: Translator): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return t("clawkeep.anyMoment");
  const totalMin = Math.round(diff / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return t("clawkeep.inDays", { days, hours });
  if (hours > 0) return t("clawkeep.inHours", { hours, mins });
  return t("clawkeep.inMinutes", { mins });
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
  const { t } = useT();
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
      onError(t("clawkeep.schedule.saveFailed", { error: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${CARD} space-y-4`}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">{t("clawkeep.schedule.title")}</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {draft.enabled
              ? t("clawkeep.schedule.nextRun", { when: formatNextRun(nextRunAtMs, t) })
              : t("clawkeep.schedule.off")}
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
                {freq === "daily" ? t("clawkeep.schedule.daily") : t("clawkeep.schedule.weekly")}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs text-[var(--text-muted)] w-16">{t("clawkeep.schedule.time")}</label>
            <input
              type="time"
              value={draft.timeOfDay}
              onChange={(e) => setDraft((d) => ({ ...d, timeOfDay: e.target.value }))}
              className="px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-white/10 text-sm text-gray-200 focus:outline-none focus:border-emerald-500/50"
            />
            <span className="text-xs text-[var(--text-muted)]">{t("clawkeep.schedule.deviceLocal")}</span>
          </div>

          {draft.frequency === "weekly" && (
            <div className="flex items-center gap-3">
              <label className="text-xs text-[var(--text-muted)] w-16">{t("clawkeep.schedule.day")}</label>
              <div className="flex gap-1 flex-wrap">
                {WEEKDAY_LABEL_KEYS.map((labelKey, idx) => (
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
                    {t(labelKey)}
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
                {saving ? t("clawkeep.schedule.saving") : t("clawkeep.schedule.save")}
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
  const { t } = useT();
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
            {t("clawkeep.cancel")}
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
  const { t } = useT();
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
      <h2 className="relative text-3xl font-bold font-display">{t("clawkeep.pair.title")}</h2>
      <p className="relative mt-1.5 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
        {t("clawkeep.pair.description")}
      </p>
      <button
        type="button"
        onClick={onPair}
        disabled={busy}
        className="relative mt-7 px-6 py-2.5 rounded-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white text-sm font-semibold shadow-lg cursor-pointer"
      >
        {busy ? t("clawkeep.pair.connecting") : t("clawkeep.pair.button")}
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
  const { t } = useT();
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
        {phase === "configuring"
          ? t("clawkeep.pair.configuring")
          : t("clawkeep.pair.enterCode")}
      </h2>
      <div className="flex items-center justify-center gap-2 py-2">
        <span
          className="select-all cursor-text px-4 py-2 rounded-lg bg-black/40 border border-white/10 font-mono text-2xl tracking-[0.2em] text-orange-200"
          aria-label={t("clawkeep.pair.codeAriaLabel")}
        >
          {code}
        </span>
        <button
          type="button"
          onClick={onCopyClick}
          aria-label={copied ? t("clawkeep.pair.codeCopied") : t("clawkeep.pair.copyCode")}
          className="px-2.5 py-2 rounded-md text-xs font-medium text-orange-300 bg-black/30 border border-white/10 hover:bg-black/50 cursor-pointer transition-colors"
        >
          {copied ? t("clawkeep.pair.copied") : t("clawkeep.pair.copy")}
        </button>
      </div>
      <p className="text-sm text-[var(--text-muted)] text-center">
        {t("clawkeep.pair.typeCodeOnPortal")}
      </p>
      <div className="flex justify-center gap-2">
        <a
          href={challenge.verification_url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-orange-300 hover:text-orange-200 underline"
        >
          {t("clawkeep.pair.reopenPortal")}
        </a>
        <span className="text-xs text-[var(--text-muted)]">·</span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-[var(--text-muted)] hover:text-gray-200"
        >
          {t("clawkeep.cancel")}
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)] text-center">
        {phase === "configuring"
          ? t("clawkeep.pair.savingToken")
          : t("clawkeep.pair.waitingApproval")}
      </p>
    </div>
  );
}

function BackupProgressPanel({
  kind = "backup",
  stepLabel: explicitStepLabel,
  uploadBytesTotal = 0,
  uploadBytesDone = 0,
  uploadStartedAtMs = 0,
  heartbeatAtMs = 0,
  onReset,
}: {
  kind?: "backup" | "restore";
  /** Friendly label for the daemon's current sub-phase (backup only). */
  stepLabel?: string;
  /** Live upload fields; non-zero only while the daemon is in the upload phase. */
  uploadBytesTotal?: number;
  uploadBytesDone?: number;
  uploadStartedAtMs?: number;
  /** Last heartbeat timestamp; used to surface the "looks stuck" reset
   * affordance after a few minutes without progress. */
  heartbeatAtMs?: number;
  /** Backup-only: invoked when the user taps "Reset stuck backup". The
   * parent decides what that means (POSTs to /reset-state, clears the
   * spinner, etc.). When omitted the affordance is hidden. */
  onReset?: () => void;
}) {
  const { t } = useT();
  // `nowMs` is sampled by the 1s tick so render stays pure (no `Date.now()`
  // reads at render time — the React compiler rule that flags those is on).
  // It's the only thing the panel uses time for: deriving the upload MB/s
  // line. The visible elapsed-time clock was removed at the user's request.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Uploading is the only phase where we have real bytes-in-flight numbers.
  // Other phases (archiving, checking-stats) stay on the indeterminate bar.
  const uploading = uploadBytesTotal > 0 && uploadStartedAtMs > 0 && nowMs > 0;
  const uploadElapsedSec = uploading
    ? Math.max(0.001, (nowMs - uploadStartedAtMs) / 1000)
    : 0;
  const throughputBps = uploading ? uploadBytesDone / uploadElapsedSec : 0;
  // Cap the rendered ratio at 1.0 — Python rounds bytes_done up to total at
  // the end, but a slightly stale snapshot shouldn't render >100% mid-poll.
  const uploadRatio = uploading
    ? Math.min(1, uploadBytesDone / Math.max(1, uploadBytesTotal))
    : 0;

  const isBackup = kind === "backup";
  const fallback = isBackup
    ? t("clawkeep.progress.backupFallback")
    : t("clawkeep.progress.restoreFallback");
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
        ariaLabel: t("clawkeep.progress.backupAria"),
      }
    : {
        border: "border-orange-400/30",
        gradient: "from-orange-500/10 via-orange-500/5",
        spinnerRing: "border-orange-400/30 border-t-orange-400",
        text: "text-orange-100",
        track: "bg-orange-500/15",
        bar: "bg-orange-400",
        ariaLabel: t("clawkeep.progress.restoreAria"),
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
            {isBackup
              ? t("clawkeep.progress.backupTitle")
              : t("clawkeep.progress.restoreTitle")}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {stepLabel}
          </div>
        </div>
      </div>
      <div
        className={`mt-4 h-1.5 rounded-full ${palette.track} overflow-hidden`}
        role="progressbar"
        aria-label={palette.ariaLabel}
        aria-valuemin={0}
        aria-valuemax={uploading ? 100 : undefined}
        aria-valuenow={uploading ? Math.round(uploadRatio * 100) : undefined}
      >
        {uploading ? (
          <div
            className={`h-full rounded-full ${palette.bar} transition-[width] duration-300 ease-out`}
            style={{ width: `${(uploadRatio * 100).toFixed(1)}%` }}
          />
        ) : (
          <div
            className={`h-full rounded-full ${palette.bar}`}
            style={{ animation: "indeterminate 1.6s ease-in-out infinite" }}
          />
        )}
      </div>
      {uploading && (
        <div className={`mt-2 flex items-center justify-between text-xs ${palette.text} tabular-nums`}>
          <span>
            {formatBytes(uploadBytesDone)} / {formatBytes(uploadBytesTotal)}
            <span className="text-[var(--text-muted)]"> · {(uploadRatio * 100).toFixed(1)}%</span>
          </span>
          <span>{formatBytes(Math.round(throughputBps))}/s</span>
        </div>
      )}
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        {isBackup
          ? t("clawkeep.progress.backupHint")
          : t("clawkeep.progress.restoreHint")}
      </p>
      {/* "Looks stuck?" recovery link. Surfaces after ~6 minutes on the
          same heartbeat (real Jetson backups complete in 2-5 min) — gives
          the user a way out before the 30-minute auto-stale kicks in.
          Only on backup; restore has its own swap-cant-be-interrupted
          hint above and a reset there would be actively dangerous. */}
      {isBackup && onReset && heartbeatAtMs > 0
        && nowMs > 0 && nowMs - heartbeatAtMs > RESET_HINT_AFTER_MS && (
        <div className="mt-2 flex items-center justify-end">
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-[var(--text-muted)] hover:text-emerald-200 underline underline-offset-2 cursor-pointer"
          >
            {t("clawkeep.progress.resetStuck")}
          </button>
        </div>
      )}
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
  headlineKey: string;
  subheadKey: string;
  badgeKey: string;
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
    headlineKey: "clawkeep.status.protected",
    subheadKey: "clawkeep.status.protectedSub",
    badgeKey: "clawkeep.badge.protected",
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
    headlineKey: "clawkeep.status.lapsed",
    subheadKey: "clawkeep.status.lapsedSub",
    badgeKey: "clawkeep.badge.atRisk",
    iconName: "gpp_maybe",
  },
  unprotected: {
    ...RED_PALETTE,
    headlineKey: "clawkeep.status.unprotected",
    subheadKey: "clawkeep.status.unprotectedSub",
    badgeKey: "clawkeep.badge.unprotected",
    iconName: "gpp_bad",
  },
};

function DashboardCard({
  status,
  onBackup,
  onOpenRestore,
  onResetStuck,
  busyKind,
}: {
  status: ClawKeepStatus;
  onBackup: () => void;
  onOpenRestore: () => void;
  onResetStuck: () => void;
  busyKind: "backup" | "restore" | null;
}) {
  const { t } = useT();
  if (busyKind) {
    const stepKey = busyKind === "backup" ? STEP_LABEL_KEYS[status.currentStep] : undefined;
    return (
      <BackupProgressPanel
        kind={busyKind}
        stepLabel={stepKey ? t(stepKey) : undefined}
        uploadBytesTotal={busyKind === "backup" ? status.uploadBytesTotal : 0}
        uploadBytesDone={busyKind === "backup" ? status.uploadBytesDone : 0}
        uploadStartedAtMs={busyKind === "backup" ? status.uploadStartedAtMs : 0}
        heartbeatAtMs={busyKind === "backup" ? status.lastHeartbeatAtMs : 0}
        onReset={busyKind === "backup" ? onResetStuck : undefined}
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
        {t(copy.badgeKey)}
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

      <h2 className="relative text-3xl font-bold font-display mt-2">{t(copy.headlineKey)}</h2>
      <p className="relative mt-1.5 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
        {t(copy.subheadKey)}
      </p>

      {/* Stats strip — compact, equal-width, no card chrome to keep the eye on the shield */}
      <div className="relative mt-6 grid grid-cols-3 gap-6 w-full max-w-md text-center">
        <Stat label={t("clawkeep.stat.lastBackup")} value={timeAgo(status.lastBackupAtMs, t)} />
        <Stat label={t("clawkeep.stat.cloudUsage")} value={formatBytes(status.cloudBytes)} />
        <Stat label={t("clawkeep.stat.snapshots")} value={status.snapshotCount.toString()} />
      </div>

      {/* Action row */}
      <div className="relative mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onBackup}
          disabled={disabled}
          className={`px-6 py-2.5 rounded-full ${copy.primaryClass} disabled:opacity-50 text-white text-sm font-semibold shadow-lg transition-colors cursor-pointer`}
        >
          {state === "protected" ? t("clawkeep.backupNow") : t("clawkeep.protectMyOpenclaw")}
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
            {t("clawkeep.restoreFromSnapshot")}
          </button>
        )}
      </div>
    </div>
  );
}

function SystemCard({ status }: { status: ClawKeepStatus }) {
  const { t } = useT();
  return (
    <div className={`${CARD} space-y-2 border-amber-500/20 bg-amber-500/5`}>
      <h2 className="font-semibold text-amber-200">⚙️ {t("clawkeep.system.setupNeeded")}</h2>
      <ul className="text-sm text-amber-100 space-y-1">
        {!status.openclawInstalled && (
          <li>
            <code className="bg-black/30 px-1 rounded">openclaw</code>{" "}
            {t("clawkeep.system.notOnPath")}{" "}
            <code className="bg-black/30 px-1 rounded">npm install -g openclaw</code>.
          </li>
        )}
        {!status.daemonInstalled && (
          <li>
            <code className="bg-black/30 px-1 rounded">clawkeepd</code>{" "}
            {t("clawkeep.system.notOnPathFrom")}{" "}
            <code className="bg-black/30 px-1 rounded">clawbox/clawkeep</code>{" "}
            {t("clawkeep.system.run")}{" "}
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
  const { t } = useT();
  const tail = result.stderrTail || result.stdoutTail || t("clawkeep.result.noOutput");
  return (
    <div
      className={`${CARD} ${
        result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <h2 className="font-semibold">
        {result.ok
          ? t("clawkeep.result.backupOk")
          : t("clawkeep.result.backupFailed", { code: result.exitCode })}
      </h2>
      <pre className="mt-2 text-[11px] font-mono text-gray-200/90 whitespace-pre-wrap max-h-48 overflow-auto bg-black/30 p-2 rounded">
        {tail}
      </pre>
    </div>
  );
}

function RestoreResultCard({ result }: { result: RestoreResponse }) {
  const { t } = useT();
  return (
    <div className={`${CARD} border-emerald-500/30 bg-emerald-500/5 space-y-2`}>
      <h2 className="font-semibold">{t("clawkeep.result.restoreOk")}</h2>
      <p className="text-sm text-[var(--text-muted)]">
        {t("clawkeep.result.restoredPrefix")}{" "}
        <code className="bg-black/30 px-1 rounded">{result.archive}</code>{" "}
        ({formatBytes(result.archiveBytes)}).
      </p>
      <ul className="text-xs space-y-1">
        {result.assets.map((a) => (
          <li key={a.targetPath} className="text-gray-300">
            <span className="font-mono">{a.targetPath}</span>{" "}
            <span className="text-[var(--text-muted)]">
              ({formatBytes(a.bytesRestored)} —{" "}
              {t("clawkeep.result.previousAt")}{" "}
              <span className="font-mono">{a.backupPath}</span>)
            </span>
          </li>
        ))}
      </ul>
      {result.restartErrors.length > 0 && (
        <p className="text-xs text-amber-300">
          ⚠️ {t("clawkeep.result.restartFailed", { count: result.restartErrors.length })}{" "}
          <code className="bg-black/30 px-1 rounded">sudo systemctl restart clawbox-gateway</code>{" "}
          {t("clawkeep.result.manually")}
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
  const { t } = useT();
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
      aria-label={t("clawkeep.restoreModal.aria")}
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
                <h2 className="text-lg font-semibold leading-tight">{t("clawkeep.restoreModal.title")}</h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {t("clawkeep.restoreModal.description")}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("clawkeep.restoreModal.close")}
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
              <span>{t("clawkeep.restoreModal.fetching")}</span>
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
              {t("clawkeep.restoreModal.empty")}
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
                              {t("clawkeep.restoreModal.latest")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[var(--text-muted)] flex items-center gap-2">
                          <span>{formatBytes(s.size_bytes)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{timeAgo(s.last_modified_ms, t)}</span>
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
            {t("clawkeep.restoreModal.footerPrefix")}{" "}
            <code className="bg-black/40 px-1 rounded">~/.openclaw.bak-restore-*</code>.
          </span>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Encryption modals
// ─────────────────────────────────────────────────────────────────────

/**
 * First-time-encryption setup. Two password fields + a "I understand the
 * data is unrecoverable if I lose this passphrase" checkbox the user has
 * to tick. We send `{ passphrase, confirm }` so the API can mismatch-check
 * server-side too (browser autofill occasionally fills the second field
 * with a stale value, and silently encrypting with the wrong one would be
 * a foot-gun the user couldn't recover from).
 */
function SetPassphraseModal({
  onCancel,
  onSaved,
  onError,
}: {
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Esc cancels the modal (consistent with ConfirmDialog and RestoreModal).
  // Skip while a save is in flight so the user can't half-cancel a request.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  const canSubmit =
    pw.length >= 8 && pw === confirm && acknowledged && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      const res = await fetch("/setup-api/clawkeep/encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: pw, confirm }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error || `HTTP ${res.status}`;
        setLocalError(msg);
        onError(msg);
        return;
      }
      onSaved();
    } catch (e) {
      const msg = (e as Error).message;
      setLocalError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1219] p-6 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-white mb-1">
          {t("clawkeep.encryption.setTitle")}
        </h2>
        <p className="text-sm text-white/60 leading-relaxed mb-4">
          {t("clawkeep.encryption.setDescription")}
        </p>

        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 mb-4 flex gap-2">
          <span
            className="material-symbols-rounded text-amber-300 shrink-0"
            style={{ fontSize: 18 }}
            aria-hidden="true"
          >
            warning
          </span>
          <p className="text-xs text-amber-100/90 leading-relaxed">
            {t("clawkeep.encryption.warning1")}{" "}
            <strong>{t("clawkeep.encryption.warning2")}</strong>
            {t("clawkeep.encryption.warning3")}
          </p>
        </div>

        <label className="block text-xs font-medium text-white/80 mb-1">
          {t("clawkeep.encryption.passphraseLabel")}
        </label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          autoComplete="new-password"
          aria-describedby="clawkeep-passphrase-hint"
          className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-orange-500/60 focus:outline-none"
          placeholder={t("clawkeep.encryption.passphrasePlaceholder")}
        />
        {/* Live "min length" feedback. Mirrors the canSubmit gate so the
            user sees why "Save" stays disabled before they tab to it. */}
        <p
          id="clawkeep-passphrase-hint"
          className={`text-[11px] mt-1 ${
            pw.length === 0
              ? "text-white/40"
              : pw.length >= 8
                ? "text-emerald-300"
                : "text-amber-300"
          }`}
        >
          {pw.length === 0
            ? t("clawkeep.encryption.passphrasePlaceholder")
            : pw.length >= 8
              ? t("clawkeep.encryption.lengthOk")
              : t("clawkeep.encryption.lengthShort", { remaining: 8 - pw.length })}
        </p>

        <label className="block text-xs font-medium text-white/80 mb-1 mt-3">
          {t("clawkeep.encryption.confirmLabel")}
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-orange-500/60 focus:outline-none"
          placeholder={t("clawkeep.encryption.confirmPlaceholder")}
        />
        {confirm.length > 0 && pw !== confirm && (
          <p className="text-[11px] text-red-300 mt-1">
            {t("clawkeep.encryption.mismatch")}
          </p>
        )}

        <label className="mt-4 flex items-start gap-2 text-xs text-white/80 leading-relaxed cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 accent-orange-500"
          />
          <span>
            {t("clawkeep.encryption.ack1")}{" "}
            <strong>{t("clawkeep.encryption.ack2")}</strong>
            {t("clawkeep.encryption.ack3")}
          </span>
        </label>

        {localError && (
          <p className="mt-3 text-xs text-red-300">{localError}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-white/70 bg-white/5 hover:bg-white/10 cursor-pointer"
          >
            {t("clawkeep.cancel")}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-1.5 rounded-md text-xs font-semibold text-white bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {submitting ? t("clawkeep.encryption.saving") : t("clawkeep.encryption.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Restore-time prompt. Used when the device-local passphrase is missing
 * (e.g. user reset the device, or chose a snapshot uploaded from a
 * different device) or when a previous restore attempt's passphrase was
 * wrong. The submit handler reports back whether it should keep the modal
 * open (wrong-password retry) or close it (success / hard failure).
 */
function RestorePassphraseModal({
  name,
  initialError,
  onCancel,
  onSubmit,
}: {
  name: string;
  initialError?: string;
  onCancel: () => void;
  onSubmit: (passphrase: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(initialError ?? null);

  // Esc cancels the modal (consistent with ConfirmDialog/RestoreModal).
  // Skip while a decrypt+restore is in flight — interrupting via Esc
  // wouldn't actually abort the underlying CLI subprocess and would
  // leave the user thinking they cancelled when they didn't.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || submitting) return;
    setSubmitting(true);
    const outcome = await onSubmit(pw);
    setSubmitting(false);
    if (!outcome.ok) {
      setErr(outcome.error || t("clawkeep.encryption.restoreFailed"));
    }
  };

  // Description splits around the snapshot name so the <code> styling can
  // wrap the dynamic value while the rest of the sentence stays translatable.
  const descPrefix = t("clawkeep.encryption.enterDescriptionPrefix");
  const descSuffix = t("clawkeep.encryption.enterDescriptionSuffix");

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1219] p-6 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-white mb-1">
          {t("clawkeep.encryption.enterTitle")}
        </h2>
        <p className="text-sm text-white/60 leading-relaxed mb-4">
          {descPrefix} <code className="text-emerald-300">{name}</code> {descSuffix}
        </p>

        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          autoComplete="off"
          className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-orange-500/60 focus:outline-none"
          placeholder={t("clawkeep.encryption.passphraseLabel")}
        />
        {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

        <p className="mt-3 text-[11px] text-white/40 leading-relaxed">
          {t("clawkeep.encryption.localOnly")}
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-white/70 bg-white/5 hover:bg-white/10 disabled:opacity-50 cursor-pointer"
          >
            {t("clawkeep.cancel")}
          </button>
          <button
            type="submit"
            disabled={!pw || submitting}
            className="px-4 py-1.5 rounded-md text-xs font-semibold text-white bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {submitting
              ? t("clawkeep.encryption.decrypting")
              : t("clawkeep.encryption.decryptRestore")}
          </button>
        </div>
      </form>
    </div>
  );
}
