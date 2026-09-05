"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { StepStatus, StepState, UpdateState } from "@/lib/updater";
import { useT } from "@/lib/i18n";
import { cleanVersion } from "@/lib/version-utils";
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

function stepTextClass(status: StepStatus): string {
  switch (status) {
    // Cyan means DONE on every box; the step in flight is simply the one
    // written in full ink.
    case "running": return "text-[var(--text-primary)]";
    case "completed": return "text-[var(--cyan-bright)]";
    case "failed": return "text-red-400";
    default: return "text-[var(--text-muted)]";
  }
}

/**
 * One 18px disc per step, four states, none of them moving.
 *
 * The running step used to carry a spinner, which is a claim about the
 * machine that a 4-minute JetPack install cannot back: it turns at the same
 * rate whether the device is working or dead. The cadence of this screen is
 * carried by the meter — twelve real completion events — and its liveness by
 * a dot that steps once per answered poll.
 */
function StepIcon({ status }: { status: StepStatus }) {
  if (status === "completed") {
    return (
      <span className="grid place-items-center shrink-0 w-[18px] h-[18px] rounded-[var(--r-full)] bg-[var(--cyan-bright)]">
        <span className="material-symbols-rounded text-[#06202a]" aria-hidden="true" style={{ fontSize: 12 }}>
          check
        </span>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="grid place-items-center shrink-0 w-[18px] h-[18px] rounded-[var(--r-full)] bg-red-500">
        <span className="material-symbols-rounded text-white" aria-hidden="true" style={{ fontSize: 12 }}>
          close
        </span>
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="grid place-items-center shrink-0 w-[18px] h-[18px] rounded-[var(--r-full)] bg-[var(--coral-tint)] border border-[var(--coral-bright)]">
        <span className="block w-1.5 h-1.5 rounded-[var(--r-full)] bg-[var(--coral-bright)]" />
      </span>
    );
  }
  return (
    <span className="grid place-items-center shrink-0 w-[18px] h-[18px] rounded-[var(--r-full)] bg-[var(--fill-2)]">
      <span className="block w-[5px] h-[5px] rounded-[var(--r-full)] bg-[var(--text-muted)]" />
    </span>
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
function Meter({ steps, done, label }: { steps: StepState[]; done: boolean; label: string }) {
  const completed = steps.filter((s) => s.status === "completed").length;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={completed}
    >
      <div className="flex gap-[var(--s-0)]" aria-hidden="true">
        {steps.map((s) => (
          <span
            key={s.id}
            className={`flex-1 h-1 rounded-[var(--r-full)] ${
              done
                ? "bg-[var(--cyan-bright)]"
                : s.status === "completed"
                  ? "bg-[var(--coral-bright)]"
                  : s.status === "failed"
                    ? "bg-red-500"
                    : "bg-[var(--fill-2)]"
            }`}
            style={{ transition: "background-color var(--d-2) var(--ease-truth)" }}
          />
        ))}
      </div>
      {/* A count, not an estimate: the box reports which steps finished and
          nothing about how long the rest will take, so nothing here pretends
          to know. Tabular figures so the number does not jitter. */}
      <p
        className="mt-[var(--s-2)] font-mono tabular-nums text-[var(--text-muted)]"
        style={{ fontSize: "var(--t-2)" }}
      >
        {completed} / {steps.length}
      </p>
    </div>
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
  const [state, setState] = useState<UpdateState | null>(null);

  const [versions, setVersions] = useState<{
    clawbox: { current: string; target: string | null; updateAvailable?: boolean };
    openclaw: { current: string | null; target: string | null; updateAvailable?: boolean };
    // Optional: a payload from a server that predates the field must keep
    // behaving exactly as before, so ABSENT is "not known", never "unreachable".
    remote?: { reachable: boolean; refusedAnonymously?: boolean; reason?: string };
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

  const showLedger = !(isFailed && state.error) && state.steps.length > 0;

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
      {isFailed && state.error && (
        <div
          className="mb-[var(--s-4)] p-[var(--s-3)] bg-red-500/10 border border-red-500/20 rounded-[var(--r-1)] text-red-400"
          style={{ fontSize: "var(--t-4)", lineHeight: 1.55 }}
        >
          {state.error}
        </div>
      )}

      {showLedger && (
        <>
          <Meter steps={state.steps} done={!!isDone} label={t("update.title")} />

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

          <ul className="list-none mt-[var(--s-5)] mb-[var(--s-5)]">
            {state.steps.map((step) => (
              <li
                key={step.id}
                className="flex items-center gap-[var(--s-2)] py-[var(--s-2)]"
              >
                <StepIcon status={step.status} />
                <span
                  className={`flex-1 min-w-0 ${stepTextClass(step.status)}`}
                  style={{
                    fontSize: "var(--t-4)",
                    fontWeight: step.status === "running" ? "var(--w-label)" : undefined,
                    transition: "color var(--d-2) var(--ease-standard)",
                  }}
                >
                  {step.label}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Failed step errors */}
      {(isDone || isFailed) && !state.error &&
        state.steps
          .filter((s) => s.status === "failed")
          .map((s) => (
            <div
              key={s.id}
              className="mt-[var(--s-2)] p-[var(--s-3)] bg-red-500/10 border border-red-500/20 rounded-[var(--r-1)] text-red-400"
              style={{ fontSize: "var(--t-2)", lineHeight: 1.55 }}
            >
              <span style={{ fontWeight: "var(--w-label)" }}>{s.label}:</span>{" "}
              {s.error || "Unknown error"}
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
