"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { backupSourceFor } from "@/lib/harness/backup-source";
import { deriveProtection, isBackupRunning, type ProtectionState } from "@/lib/clawkeep-protection";
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, FIELD } from "./coding-agent-ui";
import ClawKeepWizard from "./ClawKeepWizard";
import { PairChallengeCard, type PairStartResponse } from "./ClawKeepPairChallengeCard";
import {
  CARD,
  ConfirmDialog,
  Stat,
  WEEKDAY_LABEL_KEYS,
  formatBytes,
  formatNextRun,
  jsonOrError,
  timeAgo,
} from "./clawkeep-ui";

/**
 * Is anything still missing before a backup can run?
 *
 * Reads the server's answer when it gave one, and otherwise falls back to the
 * pre-Hermes meaning of the status object — "the openclaw CLI is on PATH" —
 * so a browser holding a cached bundle against an older server still gates the
 * button the way that server intends, rather than enabling it on a box that
 * cannot archive.
 */
function archiverReady(status: ClawKeepStatus): boolean {
  return status.archiverReady ?? status.openclawInstalled;
}

type ScheduleFrequency = "daily" | "weekly";
interface ClawKeepSchedule {
  enabled: boolean;
  frequency: ScheduleFrequency;
  timeOfDay: string;
  weekday: number;
  /** Auto-cleanup window: keep the newest N unlocked snapshots. 0 disables. */
  retentionKeepLast: number;
}
interface ClawKeepStatus {
  paired: boolean;
  /** False until the owner has been through the setup wizard. Optional so a
   *  status from an older server still renders the dashboard. */
  setupComplete?: boolean;
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
  /** Which agent this box archives — decides the wording throughout. */
  agent?: "openclaw" | "hermes";
  /** Everything the archiver needs is present. On OpenClaw that means the
   *  `openclaw` CLI; on Hermes the archiver is inside the daemon, so there is
   *  nothing extra to install. Optional so a status from an older server
   *  (which had neither field) still renders. */
  archiverReady?: boolean;
  /** A snapshot from this box carries provider keys. Drives the warning that
   *  a backup is a credential. */
  backupContainsCredentials?: boolean;
  schedule: ClawKeepSchedule;
  nextRunAtMs: number;
  /** When auto-backup was last armed or tightened. Optional so a status from
   *  an older server still renders; see deriveProtection() for what it guards. */
  scheduleArmedAtMs?: number;
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

// Show a "Looks stuck?" reset button after this much wall-clock time on
// the same heartbeat. Tighter than STALE_RUNNING_MS so the user has a
// recovery path *before* the panel auto-hides.
const RESET_HINT_AFTER_MS = 6 * 60 * 1000;

interface CloudSnapshot {
  name: string;
  size_bytes: number;
  last_modified_ms: number;
  /** Human label from the manifest; null/absent = unnamed. */
  label?: string | null;
  /** Protected flag — locked snapshots can't be deleted or auto-pruned. */
  locked?: boolean;
}

interface RestoreResponse {
  ok: true;
  archive: string;
  archiveBytes: number;
  assets: { kind: string; targetPath: string; backupPath: string; bytesRestored: number }[];
  /** Restarts that could NOT be taken — the owner has to act. */
  restartErrors: string[];
  /**
   * Restarts that WERE taken and have not finished. Absent from older servers,
   * which folded these into `restartErrors` and told the owner to run
   * `systemctl restart` over a service that was already restarting.
   */
  restartPending?: string[];
  /** Members the daemon could not recreate. Absent from older servers. */
  skippedMembers?: string[];
}


interface PairPollResponse {
  status: "pending" | "configuring" | "complete" | "error";
  error?: string;
}

/**
 * A backup that WORKED. Since TASK-672 a failed run is a non-2xx carrying one
 * owner-facing sentence and a stable `code`, so `jsonOrError` throws it into
 * the page's error banner — the same place every other ClawKeep failure lands
 * — instead of this card rendering `ok:false` over the daemon's raw log line.
 */
interface BackupResponse {
  ok: true;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

/**
 * The name of the agent this box runs, for the strings that name it.
 *
 * Eight ClawKeep strings say "OpenClaw" out loud — "Protect my OpenClaw",
 * "Your OpenClaw is safe in the ClawBox cloud", "This replaces your current
 * OpenClaw state". On a Hermes box every one of them named software the device
 * does not run. They now interpolate `{agent}`, which keeps each locale's
 * existing wording and case endings intact — it is the brand that varies, not
 * the sentence.
 *
 * A context rather than a prop because the eight sites sit in five different
 * components, and this is a property of the DEVICE, not of any one card.
 * "OpenClaw" is the default because that is what a box is unless its status
 * says otherwise, and it is what every one of these strings used to say.
 */
const AgentLabelContext = createContext("OpenClaw");

function useAgentLabel(): string {
  return useContext(AgentLabelContext);
}

function agentLabelFor(agent: ClawKeepStatus["agent"]): string {
  return agent === "hermes" ? "Hermes" : "OpenClaw";
}

export default function ClawKeepApp() {
  const { t } = useT();
  // Per-feature ClawBox-AI gating lives inside the ClawKeep app itself
  // (e.g. the Cloud mode shows "Connect ClawBox AI first" inline). An
  // outer full-app login gate was tried and removed — it duplicated the
  // inline UX and broke local-only flows where ClawBox AI isn't required.
  const [status, setStatus] = useState<ClawKeepStatus | null>(null);
  // Which agent this box archives, for the strings that name it. Read before
  // the status has landed too, hence the optional chain — the default is the
  // word every one of those strings used to be hardcoded to.
  const agent = agentLabelFor(status?.agent);
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
  const pollIntervalRef = useRef<number | null>(null);
  // One clock for every judgement this window draws — the protection verdict,
  // the "how long ago" beside it, and whether a backup is still in flight.
  // Sampled on a tick of its own rather than read during render: a box whose
  // daemon is gone answers /setup-api/clawkeep with the same bytes for ever,
  // and a refresh that throws leaves `status` untouched, so a verdict drawn
  // only from new data would freeze. Seeded with the current time so a lapsed
  // box never flashes green on first paint. A minute is finer than anything it
  // decides (a 36 h window, a 1 h run cap) and coarse enough to cost nothing.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

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

  // Poll the dashboard at a cadence that depends on whether a backup is
  // running: fast (3s) during a backup so the live "running" step stays
  // current, slow (10s) otherwise so an already-open window still reflects
  // state changed elsewhere — e.g. switching the ClawBox AI account unpairs
  // ClawKeep server-side, and without this the window keeps showing the stale
  // "you're protected" screen until the user clicks something. getStatus() is
  // a cheap local-file read (no portal call). The effect re-runs whenever
  // `status` changes, so the period re-evaluates the moment a backup starts or
  // ends.
  useEffect(() => {
    // Reads the clock directly rather than `nowMs`: this is an effect, not a
    // render, and taking `nowMs` as a dependency would tear the poll down and
    // re-arm it every minute.
    const intervalMs = isBackupRunning(status, Date.now()) ? 3000 : 10000;
    // Skip a tick if the previous refresh is still in flight, so a slow/hung
    // fetch can't stack concurrent requests on the Jetson.
    let inFlight = false;
    const id = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void refresh().finally(() => { inFlight = false; });
    }, intervalMs);
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
      // No auto-open — the modal shows the code + an "Open authorization
      // page" button so the user reads the code before focus shifts to the
      // portal tab. Mirrors the ClawAI subscription-tab UX.
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

  const runBackupNow = useCallback(async (label?: string) => {
    setBusy("backup");
    setError(null);
    setBackupResult(null);
    try {
      const trimmed = label?.trim();
      const result = await jsonOrError<BackupResponse>(
        await fetch("/setup-api/clawkeep/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trimmed ? { label: trimmed } : {}),
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

  const onBackup = useCallback(async (label?: string) => {
    // First-backup gate: encryption must be configured before we let the
    // runner upload anything. Without a device-local passphrase the runner
    // exits early with NEED_PASSPHRASE, but we'd rather surface that as a
    // friendly modal than as a red error banner.
    if (!status?.encryptionConfigured) {
      setPassphraseSetup({ onSaved: () => { void runBackupNow(label); } });
      return;
    }
    void runBackupNow(label);
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
      // The restore is destructive — we move the agent's state directory aside
      // and replace it with the snapshot's contents, then bounce the service
      // that holds it open. Route the confirm through our themed dialog
      // instead of window.confirm so the look matches on every browser.
      setConfirmPending({
        title: t("clawkeep.confirm.restoreTitle", { name }),
        body: (
          <>
            <p>{t("clawkeep.confirm.restoreBody1", { agent })}</p>
            <p className="mt-2 text-[var(--text-muted)]">
              {t("clawkeep.confirm.restoreBody2", { agent })}
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
    // `agent` is interpolated into the confirmation copy, so a stale closure
    // would name the wrong agent in the one dialog that warns the customer
    // their state is about to be replaced.
    [performRestore, t, agent],
  );

  if (!status && !error) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[var(--text-muted)] bg-[var(--bg-deep)]">
        {t("clawkeep.loading")}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6 bg-[var(--bg-deep)]">
        <div className={`${CARD} max-w-md text-sm`}>
          <p className="text-red-300">⚠️ {t("clawkeep.loadFailed")}</p>
          {error && <p className="mt-2 text-xs text-[var(--text-muted)]">{error}</p>}
          <button
            type="button"
            onClick={refresh}
            className={`${BTN_PRIMARY} mt-3`}
          >
            {t("clawkeep.retry")}
          </button>
        </div>
      </div>
    );
  }

  // The front door: a box whose owner has not been through setup and is not
  // paired shows the wizard instead of a dashboard of things that cannot
  // happen yet. A paired box skips it whatever the flag says — pairing is the
  // wizard's point, and an owner who paired before the wizard existed must
  // not be sent back through it.
  if (status.setupComplete === false && !status.paired) {
    return (
      <AgentLabelContext.Provider value={agent}>
        <div className="relative h-full w-full overflow-y-auto bg-[var(--bg-deep)] text-gray-200 @container" data-testid="clawkeep-panel">
          <div className="mx-auto w-full max-w-2xl px-5 py-4 min-h-full flex flex-col">
            <ClawKeepWizard
              status={status}
              agent={agent}
              onStatusChanged={refresh}
              onDone={() => { void refresh(); }}
            />
          </div>
        </div>
      </AgentLabelContext.Provider>
    );
  }

  return (
    <AgentLabelContext.Provider value={agent}>
    {/* The Coding Agent's frame: top-anchored, one header row that says what
        this is and whether it is paired, with everything you can do from here
        beside it, and the cards below starting clean. It used to centre
        itself vertically in the window and put Portal / Unpair as two
        full-width buttons between the cards. */}
    <div className="relative h-full w-full overflow-y-auto bg-[var(--bg-deep)] text-gray-200 @container" data-testid="clawkeep-panel">
      <div className="mx-auto w-full max-w-2xl px-5 py-4">
        {/* `relative`: the backup-contents popover hangs from this row, the
            full content width, so it cannot run off a phone's screen the way
            a popover anchored to the ? button 200 px in did. */}
        <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3 mb-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }} aria-hidden="true">shield_lock</span>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">ClawKeep</h1>
            <span
              data-testid="clawkeep-state"
              className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider border rounded-full pl-1.5 pr-2 py-0.5 ${
                status.paired ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/[0.07]" : "text-[var(--text-muted)] border-white/15"
              }`}
            >
              <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${status.paired ? "bg-emerald-400" : "bg-[var(--text-muted)]"}`} />
              {status.paired ? t("clawkeep.state.paired") : t("clawkeep.state.unpaired")}
            </span>
            <BackupContentsInfo status={status} />
          </div>
          {status.paired && !pairChallenge && (
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={`${status.server}/portal/clawkeep`}
                target="_blank"
                rel="noopener noreferrer"
                className={BTN_SECONDARY}
                title={t("clawkeep.portalTitle")}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">dashboard</span>
                {t("clawkeep.portal")}
                <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 12 }} aria-hidden="true">open_in_new</span>
              </a>
              <button
                type="button"
                disabled={busy === "unpair"}
                onClick={onUnpair}
                className={BTN_DANGER}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">link_off</span>
                {busy === "unpair" ? t("clawkeep.unpairing") : t("clawkeep.unpairButton")}
              </button>
            </div>
          )}
        </div>
        <div className="space-y-4">
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
              onGetNewCode={onPair}
              busy={busy === "pair"}
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
                nowMs={nowMs}
                busyKind={
                  busy === "restore"
                    ? "restore"
                    : busy === "backup" || isBackupRunning(status, nowMs)
                    ? "backup"
                    : null
                }
              />
              <ScheduleCard
                schedule={status.schedule}
                nextRunAtMs={status.nextRunAtMs}
                onSaved={(next) => {
                  setStatus((prev) => prev
                    ? {
                      ...prev,
                      schedule: next.schedule,
                      nextRunAtMs: next.nextRunAtMs,
                      // Without this the shield would judge the new, tighter
                      // window against the OLD arm stamp and lapse the box on
                      // the same click. It comes from the route rather than
                      // this clock: the browser's and the box's are not the
                      // same clock, and a save that armed nothing returns the
                      // OLD stamp — which is the point.
                      scheduleArmedAtMs: next.scheduleArmedAtMs,
                    }
                    : prev);
                }}
                onError={setError}
              />
            </>
          ) : (
            <PairCard onPair={onPair} busy={busy === "pair"} />
          )}

          {(!archiverReady(status) || !status.daemonInstalled) && <SystemCard status={status} />}

          {backupResult && <BackupResultCard result={backupResult} />}
          {restoreResult && <RestoreResultCard result={restoreResult} />}

          {restoreOpen && (
            <RestoreModal
              onClose={() => setRestoreOpen(false)}
              onPick={(name) => onRestore(name)}
              onError={setError}
              agent={status.agent === "hermes" ? "hermes" : "openclaw"}
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
    </AgentLabelContext.Provider>
  );
}

/** What PUT /setup-api/clawkeep/schedule answers with. `scheduleArmedAtMs` is
 *  load-bearing — the shield reads it — so it is declared, not assumed. */
interface ScheduleSaveResponse {
  schedule: ClawKeepSchedule;
  nextRunAtMs: number;
  scheduleArmedAtMs: number;
}

function ScheduleCard({
  schedule,
  nextRunAtMs,
  onSaved,
  onError,
}: {
  schedule: ClawKeepSchedule;
  nextRunAtMs: number;
  onSaved: (next: ScheduleSaveResponse) => void;
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
    || draft.weekday !== schedule.weekday
    || draft.retentionKeepLast !== schedule.retentionKeepLast;

  const save = async (override?: ClawKeepSchedule) => {
    const payload = override ?? draft;
    setSaving(true);
    try {
      const body = await jsonOrError<ScheduleSaveResponse>(
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t("clawkeep.schedule.title")}</h3>
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
          <span className="w-10 h-6 bg-white/10 rounded-full peer-checked:bg-emerald-500 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--coral-bright)]" />
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
                    : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-white/5"
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
              className={`${FIELD} text-sm`}
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
                        : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-white/5"
                    }`}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Retention applies to every backup (manual or scheduled), so it lives
          outside the enabled-only block. */}
      <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="clawkeep-keep-last" className="text-xs text-[var(--text-muted)]">
            {t("clawkeep.schedule.keepLast")}
          </label>
          <input
            id="clawkeep-keep-last"
            type="number"
            min={0}
            max={9999}
            value={draft.retentionKeepLast}
            onChange={(e) => {
              const n = Math.max(0, Math.floor(Number(e.target.value)));
              setDraft((d) => ({ ...d, retentionKeepLast: Number.isFinite(n) ? n : 0 }));
            }}
            className={`${FIELD} w-20 text-sm`}
          />
          <span className="text-xs text-[var(--text-muted)]">
            {t("clawkeep.schedule.keepLastUnit")}
          </span>
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">
          {draft.retentionKeepLast === 0
            ? t("clawkeep.schedule.keepLastOff")
            : t("clawkeep.schedule.keepLastHelp")}
        </p>
      </div>

      {dirty && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => save()}
            className={BTN_PRIMARY}
          >
            {saving ? t("clawkeep.schedule.saving") : t("clawkeep.schedule.save")}
          </button>
        </div>
      )}
    </div>
  );
}

function PairCard({ onPair, busy }: { onPair: () => void; busy: boolean }) {
  const { t } = useT();
  const agent = useAgentLabel();
  return (
    <div className={`${CARD} flex flex-col items-center text-center py-8`}>
      <div className="w-16 h-16 rounded-full flex items-center justify-center bg-gradient-to-br from-orange-400 via-orange-500 to-amber-600 shadow-[0_0_28px_rgba(249,115,22,0.35)]">
        <span
          className="material-symbols-rounded text-white"
          style={{ fontSize: 36, fontVariationSettings: "'FILL' 1, 'wght' 600" }}
          aria-hidden="true"
        >
          shield_lock
        </span>
      </div>
      <h2 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">{t("clawkeep.pair.title")}</h2>
      <p className="mt-1 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
        {t("clawkeep.pair.description", { agent })}
      </p>
      <button type="button" onClick={onPair} disabled={busy} className={`${BTN_PRIMARY} mt-5`}>
        {busy ? t("clawkeep.pair.connecting") : t("clawkeep.pair.button")}
      </button>
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
  const agent = useAgentLabel();
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
    : t("clawkeep.progress.restoreFallback", { agent });
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
              ? t("clawkeep.progress.backupTitle", { agent })
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

interface ProtectionCopy {
  headlineKey: string;
  subheadKey: string;
  badgeKey: string;
  iconName: string;
  badgeClass: string;
  discClass: string;
  iconClass: string;
}

const COPY_BY_STATE: Record<ProtectionState, ProtectionCopy> = {
  protected: {
    headlineKey: "clawkeep.status.protected",
    subheadKey: "clawkeep.status.protectedSub",
    badgeKey: "clawkeep.badge.protected",
    iconName: "verified_user",
    badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    discClass:
      "bg-gradient-to-br from-emerald-400 via-emerald-500 to-teal-600 shadow-[0_0_28px_rgba(16,185,129,0.35)]",
    iconClass: "text-white drop-shadow-[0_0_10px_rgba(16,185,129,0.55)]",
  },
  // Amber, not red: a box that was protected and has drifted is a different
  // thing from one that never was, and the two used to be indistinguishable
  // at a glance because they shared a palette.
  lapsed: {
    headlineKey: "clawkeep.status.lapsed",
    subheadKey: "clawkeep.status.lapsedSub",
    badgeKey: "clawkeep.badge.atRisk",
    iconName: "gpp_maybe",
    badgeClass: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    discClass:
      "bg-gradient-to-br from-amber-400 via-amber-500 to-orange-600 shadow-[0_0_28px_rgba(245,158,11,0.35)]",
    iconClass: "text-white drop-shadow-[0_0_10px_rgba(245,158,11,0.55)]",
  },
  unprotected: {
    headlineKey: "clawkeep.status.unprotected",
    subheadKey: "clawkeep.status.unprotectedSub",
    badgeKey: "clawkeep.badge.unprotected",
    iconName: "gpp_bad",
    badgeClass: "bg-red-500/15 text-red-300 border-red-500/30",
    discClass:
      "bg-gradient-to-br from-red-400 via-red-500 to-rose-600 shadow-[0_0_28px_rgba(239,68,68,0.35)]",
    iconClass: "text-white drop-shadow-[0_0_10px_rgba(239,68,68,0.55)]",
  },
};

function DashboardCard({
  status,
  onBackup,
  onOpenRestore,
  onResetStuck,
  busyKind,
  nowMs,
}: {
  status: ClawKeepStatus;
  onBackup: (label?: string) => void;
  onOpenRestore: () => void;
  onResetStuck: () => void;
  busyKind: "backup" | "restore" | null;
  /** The window's shared clock — see ClawKeepApp. Passed in so the verdict and
   *  the "when" printed beside it cannot be drawn from two different reads. */
  nowMs: number;
}) {
  const { t } = useT();
  const agent = agentLabelFor(status.agent);
  // Optional "Name this backup" field for the manual run — passed to the
  // daemon as the snapshot label. Cleared after we hand it off.
  const [backupName, setBackupName] = useState("");
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

  const disabled = !status.daemonInstalled || !archiverReady(status);
  // No snapshots → restore nothing. Hide rather than offer an action that's
  // guaranteed to be empty.
  const canRestore = !disabled && status.snapshotCount > 0;

  const protection = deriveProtection(status, nowMs);
  const copy = COPY_BY_STATE[protection.state];
  // A backup that simply aged out needs its own sentence: the generic "your
  // last backup didn't complete" is wrong when the last one completed fine
  // and nothing has run since.
  const subheadKey = protection.reason === "stale"
    ? "clawkeep.status.staleSub"
    : protection.reason === "blocked"
    ? "clawkeep.status.blockedSub"
    // A green shield over a box with auto-backup off is the truth about the
    // snapshot in the cloud and silence about what happens next. Nothing will
    // make a newer one, and the window that called this box protected is the
    // no-schedule week rather than the cadence it used to keep — so one click
    // on the switch turns a five-day-stale nightly box green. The verdict is
    // deliberately left alone (judging a box its owner took off auto-backup
    // against the cadence they abandoned would cry wolf at every manual box);
    // what changes is that the card stops saying "safe, the works" and says
    // how old the backup is and that nothing is scheduled.
    : protection.state === "protected" && !status.schedule?.enabled
    ? "clawkeep.status.protectedOffSub"
    : copy.subheadKey;

  return (
    <div className={`${CARD} relative flex flex-col items-center text-center pt-8 pb-6`}>
      {/* Status badge top-right — small, clean, antivirus-style */}
      <div
        className={`absolute top-3 right-3 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wider ${copy.badgeClass}`}
      >
        {t(copy.badgeKey)}
      </div>

      {/* The shield itself — one disc with a slow breathe; the halo and the
          radiating rings that used to surround it were the only decoration of
          their kind on the desktop. */}
      <div
        className={`clawkeep-shield-breathe relative w-20 h-20 rounded-full flex items-center justify-center ${copy.discClass}`}
      >
        <span
          className={`material-symbols-rounded ${copy.iconClass}`}
          style={{ fontSize: 44, fontVariationSettings: "'FILL' 1, 'wght' 600, 'GRAD' 0" }}
          aria-hidden="true"
        >
          {copy.iconName}
        </span>
      </div>

      <h2 className="relative text-lg font-semibold text-[var(--text-primary)] mt-4">{t(copy.headlineKey)}</h2>
      <p className="relative mt-1 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
        {t(subheadKey, { agent, when: timeAgo(status.lastBackupAtMs, t, nowMs) })}
      </p>

      {/* Stats strip — compact, equal-width, no card chrome to keep the eye on the shield */}
      <div className="relative mt-5 grid grid-cols-3 gap-6 w-full max-w-md text-center">
        <Stat label={t("clawkeep.stat.lastBackup")} value={timeAgo(status.lastBackupAtMs, t, nowMs)} />
        <Stat label={t("clawkeep.stat.cloudUsage")} value={formatBytes(status.cloudBytes)} />
        <Stat label={t("clawkeep.stat.snapshots")} value={status.snapshotCount.toString()} />
      </div>

      {/* Optional name for this backup → becomes the snapshot's label */}
      {!disabled && (
        <div className="relative mt-5 w-full max-w-xs">
          <label
            htmlFor="clawkeep-backup-name"
            className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1"
          >
            {t("clawkeep.backup.nameLabel")}
          </label>
          <input
            id="clawkeep-backup-name"
            type="text"
            value={backupName}
            maxLength={120}
            onChange={(e) => setBackupName(e.target.value)}
            placeholder={t("clawkeep.backup.namePlaceholder")}
            className={`${FIELD} w-full text-sm placeholder:text-[var(--text-muted)]/60`}
          />
        </div>
      )}

      {/* Action row */}
      <div className="relative mt-4 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => onBackup(backupName)}
          disabled={disabled}
          className={BTN_PRIMARY}
        >
          {protection.state === "protected" ? t("clawkeep.backupNow") : t("clawkeep.protectMyOpenclaw", { agent })}
        </button>
        {canRestore && (
          <button
            type="button"
            onClick={onOpenRestore}
            className={BTN_SECONDARY}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
              cloud_download
            </span>
            {t("clawkeep.restoreFromSnapshot")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What travels in a snapshot from THIS box, and the warning that goes with it.
 *
 * Behind a question mark beside the title rather than a card of its own: the
 * owner asked for the list to stay out of the way until asked for. It is
 * still rendered rather than left implicit because the archive holds the
 * box's provider keys: the customer is entitled to know that before they
 * schedule a nightly upload, and to know it again before they hand a restore
 * file to anyone. The list is per-edition and comes from `backupSourceFor`,
 * whose Hermes half is pinned by test to the archiver's own asset list — so
 * this can never drift into describing a backup we do not actually make.
 */
function BackupContentsInfo({ status }: { status: ClawKeepStatus }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const source = backupSourceFor(status.agent === "hermes" ? "hermes" : "openclaw");

  // A click anywhere else, or Escape, closes it — the same manners as the
  // desktop's own menus.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("clawkeep.contents.show")}
        title={t("clawkeep.contents.show")}
        data-testid="clawkeep-contents-toggle"
        className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] transition-colors cursor-pointer ${open ? "border-white/25 bg-white/[0.06]" : "border-white/15"}`}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">question_mark</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("clawkeep.contents.title")}
          data-testid="clawkeep-contents-popover"
          className="absolute left-0 top-full z-30 mt-2 w-full max-w-[22rem] rounded-xl border border-white/10 bg-[var(--bg-elevated)] p-4 shadow-2xl space-y-2"
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">
              inventory_2
            </span>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("clawkeep.contents.title")}
            </h2>
          </div>
          <ul className="text-sm text-[var(--text-secondary)] space-y-1 list-disc list-inside">
            {source.includesKeys.map((key) => <li key={key}>{t(key)}</li>)}
          </ul>
          {source.excludesKeys.length > 0 && (
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              {t("clawkeep.contents.excludes")}{" "}
              {source.excludesKeys.map((key) => t(key)).join("; ")}.
            </p>
          )}
          {status.backupContainsCredentials !== false && (
            <p className="text-xs text-amber-200/90 leading-relaxed">
              🔒 {t("clawkeep.contents.credentialWarning")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SystemCard({ status }: { status: ClawKeepStatus }) {
  const { t } = useT();
  return (
    <div className={`${CARD} space-y-2 border-amber-500/20 bg-amber-500/5`}>
      <h2 className="text-sm font-semibold text-amber-200">⚙️ {t("clawkeep.system.setupNeeded")}</h2>
      <ul className="text-sm text-amber-100 space-y-1">
        {/* Only on the edition that HAS a separate CLI. On Hermes the archiver
            ships inside the daemon, so telling the owner to
            `npm install -g openclaw` would be an instruction that contradicts
            their SKU and fixes nothing. */}
        {status.agent !== "hermes" && !status.openclawInstalled && (
          <li>
            <code className="bg-[var(--bg-elevated)] px-1 rounded">openclaw</code>{" "}
            {t("clawkeep.system.notOnPath")}{" "}
            <code className="bg-[var(--bg-elevated)] px-1 rounded">npm install -g openclaw</code>.
          </li>
        )}
        {!status.daemonInstalled && (
          <li>
            <code className="bg-[var(--bg-elevated)] px-1 rounded">clawkeepd</code>{" "}
            {t("clawkeep.system.notOnPathFrom")}{" "}
            <code className="bg-[var(--bg-elevated)] px-1 rounded">clawbox/clawkeep</code>{" "}
            {t("clawkeep.system.run")}{" "}
            <code className="bg-[var(--bg-elevated)] px-1 rounded">pip install --user .</code>.
          </li>
        )}
      </ul>
    </div>
  );
}

function BackupResultCard({ result }: { result: BackupResponse }) {
  const { t } = useT();
  const tail = result.stdoutTail || result.stderrTail || t("clawkeep.result.noOutput");
  return (
    <div className={`${CARD} border-emerald-500/30 bg-emerald-500/5`}>
      <h2 className="font-semibold">{t("clawkeep.result.backupOk")}</h2>
      <pre className="mt-2 text-[11px] font-mono text-gray-200/90 whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--bg-elevated)] p-2 rounded">
        {tail}
      </pre>
    </div>
  );
}

/** The unit named by the first restart entry (`"<unit>: <detail>"`), so the
 *  remedy — or the "still coming back" line — names the one that is actually
 *  involved rather than a guess that is wrong on half the fleet. Falls back to
 *  the OpenClaw unit only when the string is not in the expected shape. */
function restartUnit(entries: string[]): string {
  const unit = entries[0]?.split(":")[0]?.trim();
  return unit && unit.length > 0 ? unit : "clawbox-gateway.service";
}

function RestoreResultCard({ result }: { result: RestoreResponse }) {
  const { t } = useT();
  return (
    <div className={`${CARD} border-emerald-500/30 bg-emerald-500/5 space-y-2`}>
      <h2 className="font-semibold">{t("clawkeep.result.restoreOk")}</h2>
      <p className="text-sm text-[var(--text-muted)]">
        {t("clawkeep.result.restoredPrefix")}{" "}
        <code className="bg-[var(--bg-elevated)] px-1 rounded">{result.archive}</code>{" "}
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
          {/* The unit is READ OFF the failure, not hardcoded. Each entry is
              `<unit>: <detail>`, and which unit holds the restored state is
              per-edition — `clawbox-gateway` does not exist on Hermes, so
              printing it there told the owner to run a command that cannot
              work. Naming the unit that actually failed cannot drift. */}
          <code className="bg-[var(--bg-elevated)] px-1 rounded">
            sudo systemctl restart {restartUnit(result.restartErrors)}
          </code>{" "}
          {t("clawkeep.result.manually")}
        </p>
      )}
      {(result.restartPending?.length ?? 0) > 0 && (
        <p className="text-xs text-[var(--text-muted)]" data-testid="clawkeep-restart-pending">
          {/* No ⚠️ and no command. The unit WAS restarted; it is re-reading the
              state files this restore just wrote, which is the slowest start
              this box performs. The manual `systemctl restart` the failure
              line prints would kill it mid-start and, repeated, trip
              StartLimitBurst — so the one thing this line must never do is
              read like that one. */}
          {t("clawkeep.result.restartPending", { unit: restartUnit(result.restartPending!) })}
        </p>
      )}
      {(result.skippedMembers?.length ?? 0) > 0 && (
        <p className="text-xs text-amber-300">
          {/* A restore that could not recreate part of the archive is NOT a
              clean success. Saying so here is the whole point of carrying
              `skippedMembers` out of the daemon. */}
          ⚠️ {t("clawkeep.result.skipped", { count: result.skippedMembers!.length })}
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
  agent,
}: {
  onClose: () => void;
  onPick: (name: string) => void;
  onError: (msg: string) => void;
  /** Which agent this box archives — decides where "moved aside to" points. */
  agent: "openclaw" | "hermes";
}) {
  const { t } = useT();
  const [snapshots, setSnapshots] = useState<CloudSnapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-row action state: which snapshot is being renamed (+ its draft text),
  // which is pending a delete confirm, and which has an in-flight mutation.
  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  // Pin the callbacks to refs so the fetch effect doesn't refire when the
  // parent passes inline arrows that change identity on every render.
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const load = useCallback(async (opts: { initial?: boolean } = {}) => {
    if (opts.initial) setLoading(true);
    try {
      const data = await jsonOrError<{ snapshots: CloudSnapshot[] }>(
        await fetch("/setup-api/clawkeep/snapshots", { cache: "no-store" }),
      );
      setSnapshots(data.snapshots);
    } catch (e) {
      onErrorRef.current((e as Error).message);
      // Only bail out of the modal on the very first load — a transient
      // refetch failure after an action shouldn't yank the dialog closed.
      if (opts.initial) onCloseRef.current();
    } finally {
      if (opts.initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  // Rename a snapshot (empty text clears the label back to the timestamp).
  const doRename = useCallback(async (name: string, text: string) => {
    setBusyName(name);
    try {
      await jsonOrError(
        await fetch("/setup-api/clawkeep/snapshots/label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, label: text }),
        }),
      );
      setEditing(null);
      await load();
    } catch (e) {
      onErrorRef.current((e as Error).message);
    } finally {
      setBusyName(null);
    }
  }, [load]);

  const doToggleLock = useCallback(async (s: CloudSnapshot) => {
    setBusyName(s.name);
    try {
      await jsonOrError(
        await fetch("/setup-api/clawkeep/snapshots/lock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: s.name, locked: !s.locked }),
        }),
      );
      await load();
    } catch (e) {
      onErrorRef.current((e as Error).message);
    } finally {
      setBusyName(null);
    }
  }, [load]);

  const doDelete = useCallback(async (name: string) => {
    setBusyName(name);
    try {
      const res = await fetch("/setup-api/clawkeep/snapshots/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setConfirmDelete(null);
      await load();
    } catch (e) {
      onErrorRef.current((e as Error).message);
    } finally {
      setBusyName(null);
    }
  }, [load]);

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
        className="w-full max-w-xl rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-deep)] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="relative px-6 pt-6 pb-4 border-b border-[var(--border-subtle)]">
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
                className="w-8 h-8 rounded-full border-2 border-[var(--border-subtle)] border-t-emerald-400 animate-spin"
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
                const locked = !!s.locked;
                const rowBusy = busyName === s.name;
                const timestampLabel = parsed ? `${parsed.date} · ${parsed.time}` : s.name;
                // Prefer the human label; fall back to the formatted timestamp.
                const title = s.label && s.label.trim() ? s.label : timestampLabel;
                const isEditing = editing?.name === s.name;
                const isConfirmingDelete = confirmDelete === s.name;
                return (
                  <li
                    key={s.name}
                    className="rounded-xl border border-[var(--border-subtle)] bg-white/[0.02] px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="shrink-0 w-10 h-10 rounded-lg bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center">
                        <span
                          className={`material-symbols-rounded ${locked ? "text-amber-300" : "text-[var(--text-muted)]"}`}
                          style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
                          aria-hidden="true"
                        >
                          {locked ? "lock" : "inventory_2"}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              autoFocus
                              value={editing.text}
                              maxLength={120}
                              onChange={(e) => setEditing({ name: s.name, text: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void doRename(s.name, editing.text);
                                if (e.key === "Escape") setEditing(null);
                              }}
                              placeholder={t("clawkeep.snapshot.renamePlaceholder")}
                              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-sm text-gray-200 focus:outline-none focus:border-emerald-500/50"
                            />
                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() => void doRename(s.name, editing.text)}
                              className="shrink-0 px-2.5 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-50 cursor-pointer"
                            >
                              {t("clawkeep.snapshot.save")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(null)}
                              className="shrink-0 px-2.5 py-1.5 rounded-md border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:bg-white/5 cursor-pointer"
                            >
                              {t("clawkeep.cancel")}
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-gray-100 truncate">
                                {title}
                              </span>
                              {locked && (
                                <span
                                  className="shrink-0 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[9px] font-bold tracking-wider border border-amber-500/30"
                                  title={t("clawkeep.snapshot.locked")}
                                >
                                  🔒 {t("clawkeep.snapshot.locked")}
                                </span>
                              )}
                              {newest && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[9px] font-bold tracking-wider border border-emerald-500/30">
                                  {t("clawkeep.restoreModal.latest")}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[11px] text-[var(--text-muted)] flex items-center gap-2">
                              {/* When a custom label is shown above, surface the
                                  timestamp here so the user still sees when it ran. */}
                              {s.label && s.label.trim() && (
                                <>
                                  <span>{timestampLabel}</span>
                                  <span aria-hidden="true">·</span>
                                </>
                              )}
                              <span>{formatBytes(s.size_bytes)}</span>
                              <span aria-hidden="true">·</span>
                              <span>{timeAgo(s.last_modified_ms, t)}</span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {!isEditing && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onPick(s.name)}
                          className="px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 text-xs font-semibold hover:bg-emerald-500/25 cursor-pointer flex items-center gap-1.5"
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
                            cloud_download
                          </span>
                          {t("clawkeep.restoreButton")}
                        </button>
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            setEditing({ name: s.name, text: s.label && s.label.trim() ? s.label : "" })
                          }
                          className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 cursor-pointer"
                        >
                          {t("clawkeep.snapshot.rename")}
                        </button>
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() => void doToggleLock(s)}
                          className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 cursor-pointer"
                        >
                          {locked ? t("clawkeep.snapshot.unlock") : t("clawkeep.snapshot.lock")}
                        </button>
                        {isConfirmingDelete ? (
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() => void doDelete(s.name)}
                              className="px-3 py-1.5 rounded-md bg-red-500/80 hover:bg-red-500 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
                            >
                              {t("clawkeep.snapshot.confirmDelete")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(null)}
                              className="px-3 py-1.5 rounded-md border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:bg-white/5 cursor-pointer"
                            >
                              {t("clawkeep.cancel")}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={rowBusy || locked}
                            title={locked ? t("clawkeep.snapshot.deleteLockedTooltip") : undefined}
                            onClick={() => setConfirmDelete(s.name)}
                            className="px-3 py-1.5 rounded-md border border-red-500/20 text-xs text-red-300/80 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                          >
                            {t("clawkeep.snapshot.delete")}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-[var(--border-subtle)] bg-white/[0.02] text-[11px] text-[var(--text-muted)] flex items-center gap-2">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
            info
          </span>
          <span>
            {t("clawkeep.restoreModal.footerPrefix")}{" "}
            {/* Per-edition: a Hermes box has no `~/.openclaw`, and this is the
                one line a customer reads if a restore goes wrong. */}
            {/* One expression, not `{...}/*...`: a `/*` sitting in JSX children
                right after a closing brace opens a comment. */}
            <code className="bg-[var(--bg-elevated)] px-1 rounded">
              {`${backupSourceFor(agent).stateDir}/*.bak-restore-*`}
            </code>.
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
        className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-6 shadow-2xl"
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
          className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-orange-500/60 focus:outline-none"
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
          className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-orange-500/60 focus:outline-none"
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
        className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-6 shadow-2xl"
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
          className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-orange-500/60 focus:outline-none"
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
