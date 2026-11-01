"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { RemoteReachability, StepStatus, StepState, UpdatePhase, UpdateState } from "@/lib/updater";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { cleanVersion } from "@/lib/version-utils";
import { UPDATE_IGNORE_BUSY_FLAG } from "@/lib/update-busy";
import ReconnectingOverlay from "./ReconnectingOverlay";

interface UpdateStepProps {
  onNext: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────
   Surfaces, in the ladders. Font sizes ride in `style` because `text-[…]`
   is ambiguous between colour and size; everything else is Tailwind so the
   hover states stay declarative.

   There is no danger rung in the ladders, so failures keep the product's
   shipped red-500 / red-400.
   ───────────────────────────────────────────────────────────────────────── */

const T_H1 = { fontSize: "var(--t-6)", lineHeight: 1.15 } as const;
const T_LEDE = { fontSize: "var(--t-4)", lineHeight: 1.6 } as const;
const T_BTN = { fontSize: "var(--t-5)", fontWeight: "var(--w-label)" as const } as const;
const T_QUIET = { fontSize: "var(--t-2)", fontWeight: "var(--w-label)" as const } as const;

const BTN_PRIMARY =
  "w-full sm:w-auto inline-flex items-center justify-center gap-[var(--s-2)] min-h-[48px] px-[var(--s-6)] rounded-[var(--r-1)] btn-gradient text-white cursor-pointer";
/* Secondaries are neutral. Coral is reserved for the one filled action, so
   an escape hatch out of the update no longer wears the same colour as the
   update itself. */
const BTN_QUIET =
  "inline-flex items-center justify-center min-h-[40px] px-[var(--s-3)] rounded-[var(--r-1)] bg-transparent border-none cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-2)]";
const BTN_GHOST =
  "w-full sm:w-auto inline-flex items-center justify-center min-h-[48px] px-[var(--s-6)] rounded-[var(--r-1)] bg-[var(--fill-1)] border border-[var(--border-subtle)] cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--fill-3)] hover:text-[var(--text-primary)]";

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-update">
      <div className="card-surface rounded-[var(--r-3)] p-[var(--s-5)] sm:p-[var(--s-7)]">
        {children}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The run's step list, meter and failure reason — shared with the System
   Update window (SystemUpdateApp), so the wizard and the desktop say the same
   thing about the same run in the same marks.
   ───────────────────────────────────────────────────────────────────────── */

/** What the updater writes for a step that threw something other than an Error. */
const PLACEHOLDER_ERROR = "Unknown error";

/** A message worth showing: present, and not the updater's placeholder. */
function realMessage(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed && trimmed !== PLACEHOLDER_ERROR ? trimmed : null;
}

/**
 * How a step is drawn. A run that settled as failed can leave the step it
 * died in still marked `running` — the updater's unexpected-error path sets
 * the phase and the run's error without touching the step — and "In progress"
 * under "Update failed" is a claim about a run that has ended. That step is
 * where it stopped.
 */
export function shownStepStatus(step: StepState, phase: UpdatePhase | undefined): StepStatus {
  return phase === "failed" && step.status === "running" ? "failed" : step.status;
}

export interface UpdateFailure {
  /** The step the run stopped at, when one is known. */
  step: StepState | null;
  /** The most specific reason the device gave, or null when it gave none worth showing. */
  reason: string | null;
  /** A second thing the device said — the run's own verdict — when it differs from `reason`. */
  context: string | null;
}

/**
 * Why a settled run stopped, from everything recorded about it, most specific
 * first: the failed step's own error, then the run's verdict, then this
 * screen's own failure to reach the run route. "Unknown error" — the updater's
 * placeholder for a step that threw a non-Error — counts as nothing, so a real
 * reason anywhere else wins over it; a run with none at all is said as such by
 * the caller (`update.noFailureReason`), never as two words that explain
 * nothing. Asked only about a run the screen calls failed, so a step still
 * marked running is the one it stopped at, whatever a stale poll's phase says.
 */
export function describeUpdateFailure(state: UpdateState | null, clientError?: string | null): UpdateFailure {
  const step = state?.steps.find((s) => shownStepStatus(s, "failed") === "failed") ?? null;
  const said = [step?.error, state?.error, clientError]
    .map(realMessage)
    .filter((message): message is string => message !== null);
  const reason = said[0] ?? null;
  return { step, reason, context: said.find((message) => message !== reason) ?? null };
}

/** The reason one failed step gives, or null — for a step that is not the run's headline failure. */
export function stepFailureReason(step: StepState): string | null {
  return realMessage(step.error);
}

/**
 * One 23px disc per step, none of them moving: a cyan check when done, the
 * step's number in coral while it runs, a red cross where it failed, the
 * number in grey while it waits.
 *
 * The running step used to carry a spinner, which is a claim about the
 * machine that a 4-minute JetPack install cannot back: it turns at the same
 * rate whether the device is working or dead. The cadence of this screen is
 * carried by the meter — one segment per real completion event.
 */
function StepDisc({ status, number }: { status: StepStatus; number: number }) {
  const base = "grid place-items-center shrink-0 w-[23px] h-[23px] rounded-[var(--r-full)] font-mono text-[10px] leading-none";
  if (status === "completed") {
    return (
      <span className={`${base} bg-[var(--cyan-wash)] text-[var(--cyan-bright)]`} aria-hidden="true">
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>check</span>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={`${base} bg-red-500/20 text-red-300`} aria-hidden="true">
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
      </span>
    );
  }
  const label = String(number).padStart(2, "0");
  if (status === "running") {
    return (
      <span className={`${base} border border-[var(--coral-bright)] bg-[var(--coral-tint)] text-orange-400`} aria-hidden="true">
        {label}
      </span>
    );
  }
  return <span className={`${base} bg-[var(--bg-elevated)] text-[var(--text-muted)]`} aria-hidden="true">{label}</span>;
}

/**
 * The run's steps, one numbered row each. Cyan means DONE on every box; the
 * step in flight is written in full ink and marked "In progress"; a step a
 * settled run stopped at is red and marked "Stopped".
 */
export function UpdateStepList({ steps, phase }: { steps: StepState[]; phase: UpdatePhase | undefined }) {
  const tr = useTr();
  const settled = phase === "failed" || phase === "completed";
  return (
    <ol className="m-0 list-none p-0" data-testid="update-step-list">
      {steps.map((step, index) => {
        const status = shownStepStatus(step, phase);
        return (
          <li
            key={step.id}
            className="flex min-h-[35px] items-center gap-3 py-1"
            data-status={status}
            aria-current={status === "running" ? "step" : undefined}
          >
            <StepDisc status={status} number={index + 1} />
            <span
              className={`min-w-0 flex-1 ${
                status === "running"
                  ? "font-medium text-[var(--text-primary)]"
                  : status === "completed"
                    ? "text-[var(--cyan-bright)]"
                    : status === "failed"
                      ? "text-red-300"
                      : "text-[var(--text-muted)]"
              }`}
              style={{ fontSize: "var(--t-2)", lineHeight: 1.4, transition: "color var(--d-2) var(--ease-standard)" }}
            >
              {step.label}
              {/* What the step is doing under a label that cannot say it —
                  "Applying system fixups" is fifteen minutes of CUDA compile
                  and multi-hundred-MB downloads. Only ever on the running
                  step, and absent unless the installer has said something. */}
              {status === "running" && step.detail && (
                <span
                  className="block truncate text-[11px] font-normal text-[var(--text-muted)]"
                  title={step.detail}
                  data-testid="update-step-detail"
                >
                  {step.detail}
                </span>
              )}
            </span>
            {/* Done and waiting are said by the disc and the colour alone,
                both hidden from a screen reader; this says them in words. */}
            {(status === "completed" || status === "pending") && (
              <span className="sr-only">
                {status === "completed"
                  ? tr("update.stepCompleted", "Completed")
                  : tr("update.stepPending", "Waiting")}
              </span>
            )}
            {status === "running" && (
              <span className="shrink-0 text-[10px] font-medium text-orange-400">{tr("update.progressRunning", "In progress")}</span>
            )}
            {status === "failed" && settled && (
              <span className="shrink-0 text-[10px] font-medium text-red-300">{tr("update.stepStopped", "Stopped")}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The meter: one segment per real step, not one bar creeping.
 *
 * The update has a fixed number of discrete completion events and no
 * intermediate signal between them, so a smooth fill would have to invent
 * the motion in the gaps. Each segment flips colour the instant its step
 * reports done, at --ease-truth (linear) — an easing curve here would
 * fabricate a velocity profile the box never reported. Between segments
 * nothing moves, which is the truth: nothing has been reported.
 */
export function UpdateStepMeter({ steps, phase, label }: { steps: StepState[]; phase: UpdatePhase | undefined; label: string }) {
  const completed = steps.filter((s) => s.status === "completed").length;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={completed}
      className="flex gap-[5px]"
    >
      {steps.map((s) => {
        const status = shownStepStatus(s, phase);
        return (
          <span
            key={s.id}
            aria-hidden="true"
            className={`h-[5px] flex-1 rounded-[var(--r-full)] ${
              phase === "completed"
                ? "bg-[var(--cyan-bright)]"
                : status === "completed"
                  ? "bg-[var(--coral-bright)]"
                  : status === "failed"
                    ? "bg-red-500"
                    : "bg-[var(--border-subtle)]"
            }`}
            style={{ transition: "background-color var(--d-2) var(--ease-truth)" }}
          />
        );
      })}
    </div>
  );
}

/**
 * "N / M steps complete" — a count, not an estimate: the box reports which
 * steps finished and nothing about how long the rest will take. Tabular
 * figures so the number does not jitter.
 */
export function UpdateStepCount({ steps }: { steps: StepState[] }) {
  const tr = useTr();
  const completed = steps.filter((s) => s.status === "completed").length;
  return (
    <span className="shrink-0 tabular-nums" data-testid="update-step-count">
      {tr("update.stepsComplete", "{done} / {total} steps complete", { done: completed, total: steps.length })}
    </span>
  );
}

function VersionRow({
  name,
  current,
  target,
  settled,
}: {
  name: string;
  current: string;
  target?: string | null;
  settled: boolean;
}) {
  return (
    <div className="flex items-baseline gap-[var(--s-3)] py-[var(--s-1)]">
      <span className="w-24 shrink-0 text-[var(--text-muted)]" style={{ fontSize: "var(--t-2)" }}>
        {name}
      </span>
      <span
        className={`font-mono ${settled ? "text-[var(--cyan-bright)]" : "text-[var(--text-muted)]"}`}
        style={{ fontSize: "var(--t-4)" }}
      >
        {current}
      </span>
      {target && (
        <>
          <span aria-hidden="true" className="text-[var(--text-muted)]">&rarr;</span>
          {/* The target is a version you do NOT have yet, so it is not cyan. */}
          <span
            className="font-mono text-[var(--text-primary)]"
            style={{ fontSize: "var(--t-4)", fontWeight: "var(--w-label)" }}
          >
            {target}
          </span>
        </>
      )}
    </div>
  );
}

function compareVersions(a: string, b: string): number {
  const pa = (cleanVersion(a) ?? a).replace(/^v/, '').split('.').map(n => Number(n) || 0);
  const pb = (cleanVersion(b) ?? b).replace(/^v/, '').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export default function UpdateStep({ onNext }: UpdateStepProps) {
  const { t } = useT();
  const tr = useTr();
  const [state, setState] = useState<UpdateState | null>(null);

  const [versions, setVersions] = useState<{
    // `updateAvailable` is `boolean | null`: null is the device saying it
    // could not look, and both fallbacks below read it as the version
    // comparison, exactly as an absent field.
    clawbox: { current: string; target: string | null; updateAvailable?: boolean | null };
    openclaw: { current: string | null; target: string | null; updateAvailable?: boolean | null };
    // Optional: a payload from a server that predates the field must keep
    // behaving exactly as before, so ABSENT is "not known", never "unreachable".
    remote?: RemoteReachability;
  } | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  // Bumped by the fetchError-branch "Retry" to re-run the status GET below.
  // Retry must only re-check status — never kick off a full update+reboot.
  const [statusReloadCount, setStatusReloadCount] = useState(0);
  // The update reboots the device at the "Updating ClawBox and restarting"
  // step. Once the server stops answering, hand off to the reconnecting overlay
  // so the user gets the same animated loop as a manual restart; it polls until
  // the server is back, then reloads (the status route resumes post-reboot).
  const [serverDown, setServerDown] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollControllerRef.current) {
      pollControllerRef.current.abort();
      pollControllerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let consecutiveFailures = 0;
    const noteFailure = () => {
      consecutiveFailures++;
      // Three misses (~6s) ⇒ the reboot has taken the server down. Surface the
      // reconnecting overlay and stop our own poll — the overlay owns the
      // reconnect-and-reload from here.
      if (consecutiveFailures >= 3) {
        setServerDown(true);
        stopPolling();
      }
    };
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          noteFailure();
          return;
        }
        consecutiveFailures = 0;
        const data: UpdateState = await res.json();
        if (controller.signal.aborted) return;
        setState(data);
        if (data.phase !== "running") {
          stopPolling();
        }
      } catch {
        if (controller.signal.aborted) return;
        noteFailure();
      }
    }, 2000);
  }, [stopPolling]);

  // The status effect must re-run for one reason only — a Retry — and never
  // because these two callbacks changed identity. Reaching them through refs
  // keeps them out of the effect's dependency list, so the effect cannot abort
  // a status read it is about to re-issue on any render but a real reload.
  const startPollingRef = useRef(startPolling);
  const stopPollingRef = useRef(stopPolling);
  useEffect(() => {
    startPollingRef.current = startPolling;
    stopPollingRef.current = stopPolling;
  });

  // Fetch initial status (but don't auto-start)
  useEffect(() => {
    const controller = new AbortController();
    async function init() {
      setFetchError(false);
      setLoading(true);
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data = await res.json();
        if (controller.signal.aborted) return;
        setState(data);
        if (data.versions) setVersions(data.versions);

        if (data.phase === "running") {
          startPollingRef.current();
        }
      } catch {
        // Whether this read was cancelled is a fact the controller holds, not
        // one to be inferred from the error's type. An abort during the body
        // read surfaces as a TypeError or a plain Error, not a DOMException, so
        // sniffing the error let a cancelled read fall through to the failure
        // banner while every request to the box had in fact returned 200. Ask
        // the controller; a genuine failure (signal not aborted) still shows.
        if (controller.signal.aborted) return;
        setFetchError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    init();
    return () => {
      controller.abort();
      stopPollingRef.current();
    };
  }, [statusReloadCount]);

  const triggerUpdate = async () => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setStarting(true);
    setFetchError(false);
    try {
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        signal: controller.signal,
        // The first-boot wizard runs before any assistant is set up, so there
        // is no agent run for the busy gate to protect, and a refusal here
        // would only strand the wizard.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [UPDATE_IGNORE_BUSY_FLAG]: true }),
      });
      if (!res.ok) throw new Error(`Start update failed (${res.status})`);
      startPolling();
    } catch {
      // Same rule as the status read: a cancelled request is not a failure, and
      // its abort will not reliably arrive as a DOMException. The controller is
      // the source of truth for whether we cancelled this.
      if (controller.signal.aborted) return;
      setFetchError(true);
      setStarting(false);
    }
  };

  useEffect(() => {
    return () => {
      actionControllerRef.current?.abort();
    };
  }, []);

  // The liveness tick, and the honest replacement for a spinner. Each answered
  // poll hands back a fresh state object, so this flips exactly once per round
  // trip the box actually completed — and the instant the box goes quiet it
  // stops, which is precisely the fact a spinner hides. Opacity only, so it
  // carries through reduced motion intact.
  //
  // Derived during render rather than in an effect (React's documented
  // adjust-state-when-input-changes pattern): an effect here would commit a
  // second render pass every two seconds, and this observes the poll — it must
  // never be able to drive it.
  const [beat, setBeat] = useState(false);
  const [beatSeen, setBeatSeen] = useState<UpdateState | null>(state);
  if (beatSeen !== state) {
    setBeatSeen(state);
    setBeat((b) => !b);
  }

  const isIdle = !state || state.phase === "idle";
  const clawboxNeedsUpdate = !!versions && (versions.clawbox.updateAvailable ?? !!versions.clawbox.target);
  const openclawNeedsUpdate = !!versions && (versions.openclaw.updateAvailable ?? !!versions.openclaw.target);
  // GitHub refuses anonymous git-upload-pack POSTs from an address that has
  // made too many, so a box being set up behind such an address compares HEAD
  // against the STALE refs its image shipped with and finds no delta. On this
  // screen that was worse than a wrong label: the wizard printed "System Up to
  // Date" and AUTO-ADVANCED after 1.5 s, onboarding the customer onto whatever
  // was in the image with no update attempted and nothing said (TASK-655).
  // Routed into the existing check-failed branch, which already offers Retry
  // and Skip — the owner decides, and setup is never blocked.
  const remoteUnreachable = versions?.remote?.reachable === false;
  const isUpToDateEarly = !loading && isIdle && !starting && versions
    && !remoteUnreachable && !clawboxNeedsUpdate && !openclawNeedsUpdate;

  // Auto-advance if already up to date — show brief flash then continue
  const autoAdvancedRef = useRef(false);
  useEffect(() => {
    if (isUpToDateEarly && !autoAdvancedRef.current) {
      autoAdvancedRef.current = true;
      const timer = setTimeout(() => onNext(), 1500);
      return () => clearTimeout(timer);
    }
  }, [isUpToDateEarly, onNext]);

  const isDone = state?.phase === "completed";
  const isFailed = state?.phase === "failed";
  const isRunning = state?.phase === "running";
  const runningStep = isRunning && state && state.currentStepIndex >= 0
    ? state.steps[state.currentStepIndex]
    : null;

  // Device is rebooting mid-update — the animated reconnect loop takes over
  // until the server returns, then reloads to resume the post-reboot steps.
  if (serverDown) {
    return <ReconnectingOverlay />;
  }

  if (loading) {
    return (
      <Card>
        <div
          className="flex items-center justify-center gap-[var(--s-3)] p-[var(--s-6)] text-[var(--text-secondary)]"
          style={{ fontSize: "var(--t-4)" }}
        >
          <div className="spinner" /> {t("update.checkingUpdates")}
        </div>
      </Card>
    );
  }

  if (fetchError || (remoteUnreachable && isIdle && !starting)) {
    return (
      <Card>
        <h1 className="font-bold font-display mb-[var(--s-2)]" style={T_H1}>
          {t("update.title")}
        </h1>
        <p className="text-red-400 mb-[var(--s-6)]" style={T_LEDE}>
          {t("update.failedToCheck")}
        </p>
        {/* Server-authored, in the owner's words rather than git's — the same
            sentence the System Update screen shows. Rendered only when the
            server sent one, so nothing here depends on a new locale key. */}
        {!fetchError && versions?.remote?.reason && (
          <p className="text-[var(--text-secondary)] mb-[var(--s-6)]" style={T_LEDE}>
            {versions.remote.reason}
          </p>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-[var(--s-3)]">
          <button
            type="button"
            onClick={() => setStatusReloadCount((c) => c + 1)}
            className={BTN_PRIMARY}
            style={T_BTN}
          >
            {t("retry")}
          </button>
          <button type="button" onClick={onNext} className={BTN_QUIET} style={T_QUIET}>
            {t("update.skipUpdates")}
          </button>
        </div>
      </Card>
    );
  }

  // Idle state — show trigger button or "up to date"
  const isUpToDate = versions && !remoteUnreachable && !clawboxNeedsUpdate && !openclawNeedsUpdate;

  const isDowngrade = versions?.clawbox.target
    ? compareVersions(versions.clawbox.current, versions.clawbox.target) > 0
    : false;

  if (isIdle && !starting) {
    return (
      <Card>
        <h1 className="font-bold font-display mb-[var(--s-2)]" style={T_H1}>
          {/* Cyan is DONE. The green gradient it replaces was a fourth hue
              carrying no information the word did not already carry. */}
          {isUpToDate ? (
            <span className="text-[var(--cyan-bright)]">{t("update.upToDate")}</span>
          ) : t("update.title")}
        </h1>
        <p className="text-[var(--text-secondary)] mb-[var(--s-6)]" style={T_LEDE}>
          {isUpToDate
            ? t("update.latestVersion")
            : t("update.updateDescription")}
        </p>
        {versions && (
          <div className="mb-[var(--s-6)]">
            <VersionRow
              name="ClawBox"
              current={cleanVersion(versions.clawbox.current) ?? versions.clawbox.current}
              target={versions.clawbox.target ? cleanVersion(versions.clawbox.target) : null}
              settled={!!isUpToDate}
            />
            {versions.openclaw.current && (
              <VersionRow
                name="OpenClaw"
                current={cleanVersion(versions.openclaw.current) ?? versions.openclaw.current}
                target={versions.openclaw.target ? cleanVersion(versions.openclaw.target) : null}
                settled={!!isUpToDate}
              />
            )}
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-[var(--s-3)]">
          {isUpToDate ? (
            <button type="button" onClick={onNext} className={BTN_PRIMARY} style={T_BTN}>
              {t("continue")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={triggerUpdate}
                className={BTN_PRIMARY}
                style={T_BTN}
              >
                {t("update.startUpdate")}
              </button>
              {isDowngrade && (
                <button type="button" onClick={onNext} className={BTN_GHOST} style={T_BTN}>
                  {t("skip")}
                </button>
              )}
            </>
          )}
        </div>
      </Card>
    );
  }

  // Loading / waiting for first poll after triggering
  if (!state || (isIdle && starting)) {
    return (
      <Card>
        <div
          className="flex items-center justify-center gap-[var(--s-3)] p-[var(--s-6)] text-[var(--text-secondary)]"
          style={{ fontSize: "var(--t-4)" }}
        >
          <div className="spinner" /> {t("update.preparingUpdate")}
        </div>
      </Card>
    );
  }

  // The run's own error, unless it is the updater's placeholder: a failFast
  // step that threw a non-Error leaves "Unknown error" here as well as on the
  // step, and drawn in the box below it hid the ledger that names the step.
  const runError = realMessage(state.error);
  const showLedger = !(isFailed && runError) && state.steps.length > 0;

  return (
    <Card>
      <h1 className="font-bold font-display mb-[var(--s-2)]" style={T_H1}>
        {isDone ? (
          <span className="text-[var(--cyan-bright)]">{t("update.updateComplete")}</span>
        ) : (
          t("update.title")
        )}
      </h1>
      <p className="text-[var(--text-secondary)] mb-[var(--s-6)]" style={T_LEDE}>
        {isDone
          ? t("update.allUpdatesApplied")
          : isFailed
            ? t("update.updateError")
            : t("update.updatingDescription")}
      </p>

      {/* Internet error (no steps shown) */}
      {isFailed && runError && (
        <div
          className="mb-[var(--s-4)] p-[var(--s-3)] bg-red-500/10 border border-red-500/20 rounded-[var(--r-1)] text-red-400"
          style={{ fontSize: "var(--t-4)", lineHeight: 1.55 }}
          data-testid="update-run-error"
        >
          {runError}
        </div>
      )}

      {showLedger && (
        <>
          <div
            className="mb-[var(--s-2)] flex items-center justify-end text-[var(--text-secondary)]"
            style={{ fontSize: "var(--t-2)" }}
          >
            <UpdateStepCount steps={state.steps} />
          </div>
          <UpdateStepMeter steps={state.steps} phase={state.phase} label={t("update.title")} />

          {/* What is happening right now, said once. The list below marks the
              same step, but a customer watching a twelve-minute install should
              not have to find it in twelve rows. */}
          {runningStep && (
            <div className="flex items-center gap-[var(--s-3)] mt-[var(--s-4)] p-[var(--s-4)] rounded-[var(--r-1)] bg-[var(--coral-wash)] border border-[var(--border-accent)]">
              <span
                aria-hidden="true"
                className="block shrink-0 w-1.5 h-1.5 rounded-[var(--r-full)] bg-[var(--coral-bright)]"
                style={{
                  opacity: beat ? 1 : 0.35,
                  transition: "opacity var(--d-3) var(--ease-standard)",
                }}
              />
              <span
                className="min-w-0 text-[var(--text-primary)]"
                style={{ fontSize: "var(--t-5)", fontWeight: "var(--w-label)", lineHeight: 1.35 }}
              >
                {runningStep.label}
              </span>
            </div>
          )}

          <div className="mt-[var(--s-4)] mb-[var(--s-5)]">
            <UpdateStepList steps={state.steps} phase={state.phase} />
          </div>
        </>
      )}

      {/* Failed step errors — the step's own reason, or a sentence saying the
          device gave none; never the updater's bare "Unknown error". */}
      {(isDone || isFailed) && !runError &&
        state.steps
          .filter((s) => shownStepStatus(s, state.phase) === "failed")
          .map((s) => (
            <div
              key={s.id}
              className="mt-[var(--s-2)] p-[var(--s-3)] bg-red-500/10 border border-red-500/20 rounded-[var(--r-1)] text-red-400"
              style={{ fontSize: "var(--t-2)", lineHeight: 1.55 }}
              data-testid="update-step-error"
            >
              <span style={{ fontWeight: "var(--w-label)" }}>{s.label}:</span>{" "}
              {stepFailureReason(s) ?? tr(
                "update.noFailureReason",
                "The device did not say why the update stopped. Run the update again; if it stops at the same step, contact ClawBox support.",
              )}
            </div>
          ))}

      {/* Action buttons */}
      {!isRunning && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-[var(--s-3)] mt-[var(--s-6)]">
          {isDone && (
            <button type="button" onClick={onNext} className={BTN_PRIMARY} style={T_BTN}>
              {t("continue")}
            </button>
          )}
          {isFailed && (
            <>
              <button
                type="button"
                onClick={triggerUpdate}
                className={BTN_PRIMARY}
                style={T_BTN}
              >
                {t("retry")}
              </button>
              <button type="button" onClick={onNext} className={BTN_QUIET} style={T_QUIET}>
                {t("update.skipUpdates")}
              </button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
