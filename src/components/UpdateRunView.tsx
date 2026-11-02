"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTr } from "@/lib/i18n-floor";
import {
  describeUpdateFailure,
  shownStepStatus,
  stepFailureReason,
  UpdateStepCount,
  UpdateStepList,
  UpdateStepMeter,
} from "@/components/UpdateStep";
import UpdateWhatsNewPanel from "@/components/UpdateWhatsNewPanel";
import type { RemoteReachability, UpdatePhase, UpdateState } from "@/lib/updater";
import { INTERRUPTED_MESSAGE_PREFIX, RESTART_STEP_ID, UPDATE_LOCK_HEADER } from "@/lib/update-constants";
import { isNamedChannel, normalizeVersion, updateWhatsNewPanel } from "@/lib/update-whats-new";
import { useUpdateWhatsNew } from "@/lib/use-update-whats-new";
import { DRIFT_RESOLVED_CODE } from "@/lib/drift-codes";
import { cleanVersion, shipsOpenclaw } from "@/lib/version-utils";
import {
  HARNESS_DOWNGRADE_BACKUP_FAILED_CODE,
  HARNESS_DOWNGRADE_CODE,
  HARNESS_DOWNGRADE_OVERRIDE_FLAG,
  HARNESS_LABEL,
  readHarnessDowngradeDetail,
  type HarnessDowngradeDetail,
} from "@/lib/harness-downgrade";

/**
 * An update run on screen, for both places an owner watches one: the System
 * Update app (its desktop window, and Settings → System Update) and /updating,
 * the page the update lock sends every desktop navigation to.
 *
 * Those were two screens (TASK-2111). The owner started a run in Settings,
 * watched this view for a few seconds, and was then moved — by the desktop's
 * notice poll and the middleware, both doing their job — onto /updating's older
 * wait screen for the rest of the update. Both now follow the run with
 * `useUpdateRun` and draw it with `UpdateRunView`; what differs is passed in:
 * /updating holds on through everything (`hold`) and adds what only it has to
 * say (`notice`).
 */

type Tr = ReturnType<typeof useTr>;

export interface ComponentVersion {
  current: string | null;
  target: string | null;
  /**
   * `null` where the device could not look — see `remote` below. It resolves
   * through `componentNeedsUpdate`, which falls back to the version comparison
   * for both null and absent, so nothing here changes behaviour on its own:
   * `remote.reachable === false` is what the screen renders the unknown from.
   */
  updateAvailable?: boolean | null;
}

export interface VersionInfo {
  clawbox: ComponentVersion & { current: string };
  openclaw: ComponentVersion;
  // Both optional: a device that has not been updated yet still answers
  // /update/versions with the old two-key shape, and the Hermes block is
  // present only on the SKUs that ship Hermes.
  hermes?: ComponentVersion;
  edition?: "openclaw" | "hermes" | "dual";
  /**
   * Whether the device actually reached its update remote — the producer's own
   * type, so a field added there (`cause`) cannot be missed here. Optional for
   * the same reason as the two above: a payload from a server that predates the
   * field must keep rendering exactly as it did, so ABSENT means "not known",
   * never "unreachable".
   */
  remote?: RemoteReachability;
}

export const CARD = "rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-5";

/** How often a run's poll asks while the box answers. */
const POLL_MS = 2_000;
/** How often a run's poll asks again while the box answers "idle" (each answer reads git on the box). */
const IDLE_POLL_MS = 10_000;
/**
 * "idle" answers, before the run was ever seen, that mean the click started
 * nothing. The run route marks the run running before it answers, so a run it
 * started never reads "idle" first.
 */
const NOT_STARTED_AFTER_IDLE = 3;
/**
 * Failed polls in a row that mean the web server went away — the rebuild
 * stopping it — rather than one request lost. The page reloads on the first
 * answer after that, to come back on the build the box now serves.
 */
const DOWN_AFTER_FAILURES = 3;

/** A run on screen: live, finished, or stopped. */
export type RunStatus = "updating" | "completed" | "failed";

/** The line across the bottom of a live or finished run: "don't power off", or what the screen around it has to say. */
export interface RunNotice {
  /** A Material Symbols glyph. */
  icon: string;
  title: string;
  note?: string | null;
  /** "warn": something the owner may have to act on. */
  tone?: "warn";
}

/** What a screen calls the run it shows. Its own failure to start or clear one is a stopped run too. */
export function runStatus(state: UpdateState | null, error: string | null): RunStatus {
  if (error || state?.phase === "failed") return "failed";
  if (state?.phase === "completed") return "completed";
  return "updating";
}

/**
 * A run the box lost (a restart, a power cut, a replaced web server) is
 * RESUMED from the step it died on by a fresh run — the verdict's own sentence
 * says so. Any other failure starts over from step 1, so it is not offered as
 * a "resume": Dismiss, then update again.
 */
export function canResume(state: UpdateState | null): boolean {
  return !!state?.error?.startsWith(INTERRUPTED_MESSAGE_PREFIX);
}

/** The run view's headline and the sentence under it. */
export function runHeadline(status: RunStatus, state: UpdateState | null, tr: Tr): { headline: string; subhead: string } {
  switch (status) {
    case "updating":
      return {
        headline: tr("update.heroUpdating", "Updating your device"),
        subhead: tr("update.updatingDescription", "Updating your ClawBox with the latest software…"),
      };
    case "completed":
      return {
        headline: tr("update.heroComplete", "Update complete"),
        subhead: state?.steps.some((s) => s.id === RESTART_STEP_ID)
          ? tr("update.heroCompleteRestart", "The device will restart in a moment.")
          : tr("update.heroCompleteSub", "Everything's been updated."),
      };
    case "failed":
      return {
        headline: tr("update.heroFailed", "Update failed"),
        // What stopped and why is the error panel's, said once, beside the
        // steps; a refused downgrade is said there in the owner's language,
        // from its detail — its English sentence is for the log and the MCP
        // tools.
        subhead: tr("update.heroFailedSub", "One step couldn't complete. See the steps below."),
      };
  }
}

/** The last answer the box gave the poll. */
export interface RunAnswer {
  phase: UpdatePhase;
  /**
   * The answer came marked with the update lock (UPDATE_LOCK_HEADER): the
   * middleware still sends desktop navigations to /updating. It marks every
   * /setup-api answer while the lock is set, so this is the middleware's own
   * reading, not a guess from the phase.
   */
  locked: boolean;
}

/** "dismissed": the server forgot the result. "kept": it did not, and the screen says why or follows what replaced it. */
export type DismissOutcome = "dismissed" | "kept";

export interface UpdateRun {
  state: UpdateState | null;
  /** This screen's own failure to start or clear a run. */
  error: string | null;
  /** A run is on this screen: started from it, or adopted. */
  started: boolean;
  /** The last poll got no answer — for minutes at a time while the rebuild has the web server down. */
  offline: boolean;
  /** Bumped each time the box answers again after an outage. */
  reconnects: number;
  answer: RunAnswer | null;
  /**
   * `hold` only: a Dismiss the box did not take. Said beside the verdict it
   * could not clear, which stays on screen with its Resume — not in its place.
   */
  dismissError: string | null;
  /** Start a run (Update, Resume); `allowDowngrade` is the owner's "Back up and update anyway". */
  trigger: (allowDowngrade?: boolean) => Promise<void>;
  /** Clear a settled run, on the server too. */
  dismiss: () => Promise<DismissOutcome>;
}

/**
 * Follow the update run: the status poll, starting a run, and dismissing one.
 *
 * `hold` is /updating's. That screen exists because an update owns the box, so
 * it follows from the first moment whatever the box answers or fails to, never
 * gives up on "idle" (the lock is what says whether a run owns the box), keeps
 * asking past "completed" until the answer says the lock is gone (`answer`),
 * asks again after a Resume or a Dismiss that did not take, and keeps a verdict
 * on screen while it is being dismissed — it leaves for the desktop instead of
 * going back to an idle System Update window.
 *
 * Without it — the System Update app — a run already going or already failed
 * when the app opens is adopted, and `onCompleted` runs once when the run this
 * screen follows completes.
 */
export function useUpdateRun({ hold = false, onCompleted }: { hold?: boolean; onCompleted?: () => void } = {}): UpdateRun {
  const tr = useTr();
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [offline, setOffline] = useState(false);
  const [reconnects, setReconnects] = useState(0);
  const [answer, setAnswer] = useState<RunAnswer | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollControllerRef.current) {
      pollControllerRef.current.abort();
      pollControllerRef.current = null;
    }
  }, []);

  /**
   * `seen`: the run this poll follows is already on screen (adopted, or
   * rejoined), so "idle" can never mean a click started nothing. `now`: ask at
   * once rather than after the first interval.
   */
  const startPolling = useCallback(({ seen = false, now = false }: { seen?: boolean; now?: boolean } = {}) => {
    if (pollRef.current !== null) return;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let serverWentDown = false;
    let failures = 0;
    let inFlight = false;
    let wasOffline = false;
    let completedSaid = false;
    // "idle" answers: when the last one came, and how many came before this
    // screen ever saw the run.
    let idleAt = 0;
    let idleBeforeRun = 0;
    let sawRun = seen;
    // Expected, and for minutes at a time: the rebuild stops the server. A
    // failed poll is the normal course of an update, never a verdict on it, so
    // it holds the screen — only the answer after it says anything.
    const noAnswer = () => {
      failures++;
      if (failures >= DOWN_AFTER_FAILURES) serverWentDown = true;
      wasOffline = true;
      setOffline(true);
    };
    const tick = async () => {
      if (inFlight) return;
      // Each "idle" answer reads git for drift on the box: while that is the
      // answer, ask less often.
      if (idleAt && Date.now() - idleAt < IDLE_POLL_MS) return;
      inFlight = true;
      try {
        const res = await fetch("/setup-api/update/status", { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          noAnswer();
          return;
        }
        failures = 0;
        const data = (await res.json()) as UpdateState;
        if (controller.signal.aborted) return;
        if (wasOffline) {
          wasOffline = false;
          setReconnects((n) => n + 1);
        }
        setOffline(false);
        const locked = res.headers?.get(UPDATE_LOCK_HEADER) === "1";
        setAnswer((prev) => (prev?.phase === data.phase && prev.locked === locked ? prev : { phase: data.phase, locked }));
        // "idle" is no verdict on the run this screen is following. A web
        // server that replaced the one running it answers "idle" until it has
        // judged that run's lock — a live run, or an interrupted one, which it
        // then reports as "failed" with the step to resume from. Stopping here
        // left the screen on "Don't power off" with every step waiting, for
        // good, over a run nothing was running any more. Keep the progress
        // last seen and keep asking — and do not reload over it either: the
        // page that came back would adopt no run and offer "Update everything".
        // Only a run this screen never saw is one that did not start.
        if (data.phase === "idle") {
          idleAt = Date.now();
          if (!sawRun && ++idleBeforeRun >= NOT_STARTED_AFTER_IDLE) {
            stopPolling();
            setError(tr("update.startFailed", "Failed to start update"));
          }
          return;
        }
        idleAt = 0;
        sawRun = true;
        if (serverWentDown) {
          window.location.reload();
          return;
        }
        // /updating asks again after a Resume whose request was lost: a run
        // the box is running is the answer to it, whatever the click said.
        if (hold && data.phase === "running") setError(null);
        setState(data);
        if (data.phase !== "running") {
          // /updating leaves on "completed" only once the lock is gone, and
          // only an answer can say that it has.
          if (!(hold && data.phase === "completed")) stopPolling();
          if (data.phase === "completed" && !completedSaid) {
            completedSaid = true;
            onCompletedRef.current?.();
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        noAnswer();
      } finally {
        inFlight = false;
      }
    };
    pollRef.current = window.setInterval(tick, POLL_MS);
    if (now) void tick();
  }, [hold, stopPolling, tr]);

  // If an update is already running when the screen opens (it was kicked off
  // from Settings, the wizard, or a prior session), immediately join the poll
  // so the live progress shows.
  //
  // A run that already FAILED is adopted the same way. It used to be ignored,
  // and the failure of 2026-09-05 is what that costs: the restart step is the
  // one that failed, so nobody was watching this page when it did, and every
  // window opened afterwards showed "1 update available — Update everything"
  // over an update that had died an hour earlier. `completed` is deliberately
  // NOT adopted — the status route synthesises that phase for any box whose
  // `update_completed` flag is set and has nothing to do, so adopting it would
  // paint "Update complete" on a device that has just been sitting there.
  //
  // /updating asks at once and goes on asking whatever the answer: it is only
  // open because an update owns the box, and the poll is how it learns when
  // that ends.
  useEffect(() => {
    if (hold) {
      startPolling({ seen: true, now: true });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/setup-api/update/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as UpdateState;
        if (cancelled) return;
        if (data.phase === "running") {
          setStarted(true);
          setState(data);
          startPolling({ seen: true });
        } else if (data.phase === "failed") {
          setStarted(true);
          setState(data);
        }
      } catch { /* idle */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Only the "full" ClawBox update path is exposed from the UI now —
  // OpenClaw is pinned by ClawBox (config/openclaw-target.txt) and rides
  // along inside the full update. The "openclaw" mode remains as a
  // server-side endpoint for SSH/MCP/admin triggers but no UI button
  // reaches it, so the type stays narrow to reflect actual call sites.
  //
  // `allowDowngrade` is the owner's "Back up and update anyway", offered only on
  // a run the server refused for installing an older harness.
  const trigger = useCallback(async (allowDowngrade = false) => {
    setStarted(true);
    setError(null);
    setDismissError(null);
    setState(null);
    // /updating goes on asking whatever the click's answer: the request can be
    // lost to the very restart it set off, and the lock may still be held.
    const followAnyway = () => {
      if (hold) startPolling({ seen: true });
    };
    try {
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `=== true`: a handler that passes its click event must never be the override.
        body: JSON.stringify(allowDowngrade === true ? { force: true, [HARNESS_DOWNGRADE_OVERRIDE_FLAG]: true } : { force: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string"
          ? data.error
          : tr("update.startFailedHttp", "Failed to start update (HTTP {status})", { status: res.status }));
        followAnyway();
        return;
      }
      // A 200 can still say the click started nothing: another run holds the
      // box, or a database compaction does. Show the run if there is one — a
      // live one to join, or one that has just failed (an interrupted run's
      // verdict carries its Resume) — and otherwise say the server's reason at
      // once rather than after the poll gives up on "idle".
      let begun: { started?: unknown; error?: unknown } | null = null;
      try {
        begun = await res.json();
      } catch { /* no body to read: the poll says what happened */ }
      if (begun?.started === false) {
        const live = await fetch("/setup-api/update/status", { cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<UpdateState>) : null))
          .catch(() => null);
        if (live?.phase === "running" || live?.phase === "failed") {
          setState(live);
          if (live.phase === "running") startPolling({ seen: true });
          return;
        }
        setError(typeof begun.error === "string"
          ? begun.error
          : tr("update.startFailed", "Failed to start update"));
        followAnyway();
        return;
      }
      // /updating never gives up on "idle": whether a run owns the box is the
      // lock's to say, and the page leaves when it does.
      startPolling({ seen: hold });
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("update.startFailed", "Failed to start update"));
      followAnyway();
    }
  }, [hold, startPolling, tr]);

  const dismiss = useCallback(async (): Promise<DismissOutcome> => {
    stopPolling();
    setDismissError(null);
    // The System Update app clears at once and goes back to its idle screen.
    // /updating keeps the verdict up until the desktop has replaced it: there
    // is no idle screen there to go back to.
    if (!hold) {
      setStarted(false);
      setError(null);
      setState(null);
    }
    // Anything the server did not take is said, with the panel put back: the
    // record is still there, and it would come back on the next reload with
    // nothing said about the dismissal that did not happen. /updating never
    // took the verdict down, so it keeps it — its Resume included — says why
    // beside it, and asks the box again.
    const refused = () => {
      const said = tr("update.dismissFailed", "The device could not clear that result. Try again in a moment.");
      if (hold) {
        setDismissError(said);
        startPolling({ seen: true, now: true });
        return;
      }
      setStarted(true);
      setState(null);
      setError(said);
    };
    // The settled run lives in the web server's memory, not in this component,
    // so clearing local state alone would hide the panel until the next mount
    // re-adopted the same dead run.
    //
    // A 409 is not an error to show — it means another surface (Settings, the
    // wizard, the MCP tools) started an update between the click and the POST,
    // and the state this button was clearing now belongs to that run. `fetch`
    // resolves for a 409, so ignoring the answer left the screen showing "1
    // update available — Update everything" over an update that was already
    // running, and a second Update from here is exactly what the run route
    // refuses. Read the status back and rejoin the live run instead.
    try {
      const res = await fetch("/setup-api/update/dismiss", { method: "POST" });
      if (res.ok) return "dismissed";
      if (res.status !== 409) {
        refused();
        return "kept";
      }
      if (hold) {
        startPolling({ seen: true, now: true });
        return "kept";
      }
      const status = await fetch("/setup-api/update/status", { cache: "no-store" });
      if (!status.ok) return "kept";
      const data = (await status.json()) as UpdateState;
      if (data.phase !== "running") return "kept";
      setStarted(true);
      setState(data);
      startPolling({ seen: true });
      return "kept";
    } catch {
      // Offline. The app's next mount adopts whatever is running; /updating
      // has the verdict still up, and says the click did not take.
      if (hold) refused();
      return "kept";
    }
  }, [hold, stopPolling, startPolling, tr]);

  return { state, error, started, offline, reconnects, answer, dismissError, trigger, dismiss };
}

/**
 * The harness this box actually runs, read-only.
 *
 * TASK-548: this screen is where an owner goes to ask "what version am I on",
 * and it named only ClawBox — so a Hermes owner could read their agent's
 * version in Settings -> About and nowhere here. The rows follow the same
 * per-edition rule About uses: OpenClaw unless the SKU is `hermes`, Hermes
 * whenever the payload carries it.
 *
 * BOTH harnesses are pinned by ClawBox and bumped inside the full update —
 * OpenClaw by `config/openclaw-target.txt`, Hermes by `HERMES_PIN_COMMIT` in
 * install.sh, which `step_hermes_install` re-checks on every update — so the
 * note is the same for both. There is no way for an owner to update either one
 * on its own, and telling them otherwise sends them looking for a button that
 * does not exist.
 *
 * `format` per row, not one shared call: `hermes.current` has already been
 * normalised server-side by `parseHermesVersion`, whose whole reason for
 * existing is that `cleanVersion`'s rules are shaped for OpenClaw/git-describe
 * output. Running the second parser over the first one's result turned
 * "Hermes Agent (dev build)" into "Hermes Agent" here while About, reading the
 * same field raw, kept it — two windows the desktop can show side by side.
 */
export function AgentVersions({ versions }: { versions: VersionInfo }) {
  const tr = useTr();
  const pinnedNote = tr("update.pinnedByClawbox", "Pinned by ClawBox — updated with it");
  const rows: { name: string; version: string | null; note: string }[] = [];
  if (shipsOpenclaw(versions)) {
    rows.push({
      name: "OpenClaw",
      version: cleanVersion(versions.openclaw.current) || versions.openclaw.current,
      note: pinnedNote,
    });
  }
  if (versions.hermes) {
    rows.push({
      name: "Hermes",
      version: versions.hermes.current,
      note: pinnedNote,
    });
  }
  if (!rows.length) return null;

  return (
    <div className={CARD} data-testid="agent-versions">
      <div className="text-base font-semibold text-gray-100">{tr("update.agent", "Agent")}</div>
      <p className="text-xs text-[var(--text-muted)] mt-0.5 mb-3">{tr("update.agentSub", "The assistant harness running on this device")}</p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.name} className="flex items-baseline justify-between gap-3 text-xs">
            <div className="min-w-0">
              <div className="text-sm text-gray-100">{row.name}</div>
              <div className="text-[11px] text-[var(--text-muted)]">{row.note}</div>
            </div>
            {/* "—", not "not installed": a null version here means the probe
                failed, never that the harness is absent. The payload only
                carries a `hermes` block on a box that HAS Hermes, and
                `hermes --version` does not answer while step_hermes_install is
                moving the checkout aside mid-update. ComponentCard below says
                the same nothing the same way. */}
            <div className="min-w-0 font-mono text-gray-100 truncate">{row.version || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "This would install an older assistant" — a branch or an update the box
 * refused because the harness it installs is older than the one that wrote the
 * assistant's data (src/lib/harness-downgrade.ts). Said from the refusal's
 * detail, one line per harness, with the documented override beside it:
 * back the data up first, then go ahead.
 */
export function HarnessDowngradeNotice({
  detail,
  kind,
  busy = false,
  backupFailure,
  onOverride,
}: {
  detail: HarnessDowngradeDetail;
  kind: "branch" | "update";
  busy?: boolean;
  /** Present when the override's backup failed: the server's reason, shown as given. */
  backupFailure?: string;
  onOverride?: () => void;
}) {
  const tr = useTr();
  return (
    <div
      role="alert"
      data-testid="update-harness-downgrade"
      className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
    >
      <p className="font-semibold text-amber-50">
        {kind === "branch" && detail.branch
          ? tr("update.harnessDowngrade.titleBranch", "Branch {branch} would install an older assistant", { branch: detail.branch })
          : tr("update.harnessDowngrade.titleUpdate", "This update would install an older assistant")}
      </p>
      <ul className="mt-1 space-y-0.5">
        {detail.downgrades.map((d) => (
          <li key={d.harness}>
            {d.schema
              ? tr(
                "update.harnessDowngrade.schemaLine",
                "{harness} data on this box is on schema {onDisk}; {harness} {target} supports up to schema {supported}.",
                { harness: HARNESS_LABEL[d.harness], onDisk: d.schema.onDisk, target: d.target, supported: d.schema.supported },
              )
              : tr(
                "update.harnessDowngrade.versionLine",
                "{harness} {installed} is installed; this would install the older {target}.",
                { harness: HARNESS_LABEL[d.harness], installed: d.installed ?? "?", target: d.target },
              )}
          </li>
        ))}
      </ul>
      {backupFailure !== undefined ? (
        <>
          <p className="mt-1">
            {tr("update.harnessDowngrade.backupFailed", "The backup could not be taken, so the older version was not installed and nothing was changed.")}
          </p>
          {backupFailure && <p className="mt-1 text-amber-200/80 break-words">{backupFailure}</p>}
        </>
      ) : (
        <p className="mt-1">
          {tr(
            "update.harnessDowngrade.body",
            "An older version cannot open data a newer one has written, so nothing was changed. Stay on your current update branch, or back up the assistant's data and continue anyway: whatever the older version cannot open is set aside in that backup.",
          )}
        </p>
      )}
      {onOverride && (
        <button
          type="button"
          onClick={onOverride}
          disabled={busy}
          className="mt-2 px-3 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs font-semibold disabled:opacity-50 cursor-pointer hover:bg-amber-500/25"
        >
          {kind === "branch"
            ? tr("update.harnessDowngrade.switchAnyway", "Back up and switch anyway")
            : tr("update.harnessDowngrade.updateAnyway", "Back up and update anyway")}
        </button>
      )}
    </div>
  );
}

/** A step's place in the list, as the log writes it: `05`. */
function stepNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/**
 * A version as the run view's version row writes it: a release always with its
 * `v` (the device says `v4.3.0`, the notes `4.3.0`, and the two must compare
 * equal), anything else — a branch build like `beta@a2c1718` — as it is.
 */
function runVersion(version: string | null): string | null {
  if (!version) return null;
  const release = normalizeVersion(version);
  return release ? `v${release}` : version;
}

/**
 * The System Update window while a run is on screen — running, finished or
 * failed.
 *
 * Running and finished: the run on the left (where it is, how far, every step
 * by number) and what the version being installed brings on the right, with
 * "don't power off" across the bottom while it runs. Failed: what stopped and
 * why first — the failed step's name, the most specific reason the updater
 * recorded, the way on (Resume where the server can resume, Dismiss always) —
 * then the log of the steps that ran, beside the stopped step list.
 *
 * The columns follow the window, not the screen (container queries), so a
 * narrow window, the Settings pane or a phone stacks them. In a stack the
 * failure comes before the steps, and it stays first in the document either
 * way: a refused downgrade's explanation and override were once out of sight
 * below ten pending steps on a laptop-sized window.
 *
 * While the box does not answer (`offline`) the progress last seen stays, but
 * the view claims nothing new about it: the count says the device is not
 * answering, and the line the running step last logged is not shown, because
 * nothing is reporting and a stale line would read as live.
 */
export function UpdateRunView({
  status,
  state,
  error,
  versions,
  channel,
  heading: Heading,
  headline,
  lede,
  offline = false,
  reconnects = 0,
  notice,
  dismissError,
  onDismiss,
  onResume,
  onOverrideDowngrade,
}: {
  status: RunStatus;
  state: UpdateState | null;
  /** This screen's own failure to start or clear a run. */
  error: string | null;
  versions: VersionInfo | null;
  /** The branch this box updates from, as far as this screen knows it. */
  channel: string | null;
  heading: "h1" | "h2";
  headline: string;
  lede: string;
  /** The box did not answer the last poll. */
  offline?: boolean;
  /** Bumped each time the box answers again after an outage: What's new is asked of the server that came back. */
  reconnects?: number;
  /** Said across the bottom in place of the run's own note — what the screen around the view needs the owner to know. */
  notice?: RunNotice;
  /** A Dismiss the box did not take, said beside the result it could not clear. */
  dismissError?: string | null;
  onDismiss: () => void;
  /** Present only for an interrupted run: starts the fresh run that resumes it. */
  onResume?: () => void;
  /** "Back up and update anyway", offered on a run refused for installing an older harness. */
  onOverrideDowngrade?: () => void;
}) {
  const tr = useTr();
  const SubHeading = Heading === "h1" ? "h2" : "h3";
  // Asked only while a run is on screen: the route reads the target's notes,
  // and an idle System Update window has no target to ask about. Asked again
  // after an outage: the first answer can predate the updater's own fetch,
  // and the server that comes back from the rebuild reads the synced checkout.
  const whatsNew = useUpdateWhatsNew(reconnects);
  const panel = updateWhatsNewPanel(whatsNew.answer);

  const failed = status === "failed";
  // The screen's verdict wins over a stale poll: a run this screen calls
  // failed has no step still "in progress".
  const phase: UpdatePhase | undefined = failed ? "failed" : state?.phase;
  const steps = state?.steps ?? [];
  const running = steps.find((s) => shownStepStatus(s, phase) === "running");
  const failure = failed ? describeUpdateFailure(state, error) : null;
  // A refused downgrade (or the backup its override could not take) is said
  // from its detail in the owner's language, never as the server's English.
  const downgrade = failed
    && (state?.errorCode === HARNESS_DOWNGRADE_CODE || state?.errorCode === HARNESS_DOWNGRADE_BACKUP_FAILED_CODE)
    ? readHarnessDowngradeDetail(state.downgrade)
    : null;
  // Non-fatal problems the update found and worked around — build drift, a
  // missing update pin it wrote for the owner. The ruling is that these
  // warn rather than block, which only means anything if they are visible;
  // the text comes from the server alongside the step labels.
  const warnings = state?.warnings ?? [];
  const restarts = steps.some((s) => s.id === RESTART_STEP_ID);

  const current = versions ? runVersion(cleanVersion(versions.clawbox.current) ?? versions.clawbox.current) : null;
  const nextBuild = versions?.clawbox.target
    ? runVersion(cleanVersion(versions.clawbox.target) ?? versions.clawbox.target)
    : null;
  // The notes name a package version, and every build a channel like beta
  // ships carries the one already installed until the next bump. There the
  // version said nothing — "v4.3.0 → 4.3.0" on a real board — and the build
  // the box is going to (`beta@a2c1718`) is what is being installed.
  const notesVersion = runVersion(panel.version);
  const target = notesVersion && notesVersion !== current ? notesVersion : nextBuild ?? notesVersion;
  const shownChannel = panel.channel ?? channel;

  const header = (
    <div className="min-w-0">
      <p className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-orange-400">
        {tr("update.title", "System Update")}
      </p>
      <Heading className="m-0 font-display text-[32px] font-bold leading-tight tracking-[-0.02em] text-[var(--text-primary)]">
        {headline}
      </Heading>
      <p className="m-0 mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">{lede}</p>
    </div>
  );

  const versionRow = (current || target) && (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[var(--text-secondary)]"
      data-testid="update-run-versions"
    >
      <span>ClawBox</span>
      {current && <span className="font-mono">{current}</span>}
      {target && target !== current && (
        <>
          {current && <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>arrow_forward</span>}
          <span className="font-mono text-[var(--text-primary)]">{target}</span>
        </>
      )}
      {isNamedChannel(shownChannel) && (
        // A QA pin can be a long branch name: it is cut, never allowed to
        // push the row past a narrow window.
        <span
          className="min-w-0 max-w-[14rem] truncate rounded-[var(--r-full)] border border-[var(--coral-edge)] bg-[var(--coral-wash)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-400"
          title={shownChannel}
          data-testid="update-run-channel"
        >
          {tr("update.whatsNewChannel", "{channel} channel", { channel: shownChannel })}
        </span>
      )}
    </div>
  );

  const waiting = status === "updating" && offline;
  const countHeadline = status === "completed"
    ? tr("update.progressFinished", "Update finished")
    : failed
      ? tr("update.progressStopped", "Update stopped")
      : waiting
        ? tr("update.notAnswering", "Restarting — not answering yet")
        : running?.label ?? (state ? tr("update.progressRunning", "In progress") : tr("update.connecting", "Connecting…"));
  const listedSteps = waiting ? steps.map((s) => (s.detail ? { ...s, detail: undefined } : s)) : steps;

  const stepsPanel = (
    <section
      className="rounded-[var(--r-2)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6"
      data-testid="update-steps-panel"
      data-offline={waiting ? "true" : undefined}
    >
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
        <span className="inline-flex min-w-0 items-center gap-2 font-medium text-[var(--text-primary)]">
          {(!state || waiting) && !failed && (
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent motion-safe:animate-spin" aria-hidden="true" />
          )}
          <span className="truncate">{countHeadline}</span>
        </span>
        {steps.length > 0 && <UpdateStepCount steps={steps} />}
      </div>
      {steps.length > 0 && (
        <>
          <div className="mt-4">
            <UpdateStepMeter steps={steps} phase={phase} label={tr("update.title", "System Update")} />
          </div>
          <div className="mt-[18px]">
            <UpdateStepList steps={listedSteps} phase={phase} />
          </div>
        </>
      )}
    </section>
  );

  const warningList = warnings.length > 0 && (
    <ul className="m-0 list-none space-y-2 p-0">
      {warnings.map((w) => {
        // The line a finished run leaves behind about drift it RESOLVED is
        // history, not a problem. Drawn amber with a warning triangle it
        // alarmed the owner exactly as the stale imperative did, which is
        // the thing the completion view is meant to stop doing.
        const resolved = w.code === DRIFT_RESOLVED_CODE;
        return (
          <li
            key={w.code}
            data-testid={`update-warning-${w.code}`}
            data-tone={resolved ? "info" : "warning"}
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
              resolved
                ? "border-[var(--border-subtle)] bg-white/5 text-[var(--text-muted)]"
                : "border-amber-500/20 bg-amber-500/10 text-amber-100"
            }`}
          >
            <span
              className={`material-symbols-rounded shrink-0 ${resolved ? "text-gray-400" : "text-amber-300"}`}
              style={{ fontSize: 16 }}
            >
              {resolved ? "history" : "warning"}
            </span>
            <span>{w.message}</span>
          </li>
        );
      })}
    </ul>
  );

  const dismissButton = (
    <button
      type="button"
      onClick={onDismiss}
      className="rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2.5 text-sm font-semibold text-gray-300 hover:bg-[var(--fill-3)] cursor-pointer"
    >
      {tr("update.dismiss", "Dismiss")}
    </button>
  );

  const dismissRefusal = dismissError && (
    <p role="alert" className="m-0 mt-3 text-xs leading-relaxed text-amber-200" data-testid="update-dismiss-error">
      {dismissError}
    </p>
  );

  const agentVersions = versions && status !== "updating" && <AgentVersions versions={versions} />;

  if (failure) {
    const ran = steps
      .map((step, index) => ({ step, index, shown: shownStepStatus(step, phase) }))
      .filter(({ shown }) => shown === "completed" || shown === "failed");
    const completedCount = steps.filter((s) => s.status === "completed").length;
    const noReason = tr(
      "update.noFailureReason",
      "The device did not say why the update stopped. Run the update again; if it stops at the same step, contact ClawBox support.",
    );

    return (
      <div className="@container w-full" data-testid="update-run" data-status={status}>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          {header}
          {versionRow}
        </div>
        {/* Placed, not reordered, on a wide window: the steps fill the left
            column, the failure and its log sit right with the feature below.
            Stacked, the document order reads failure, log, steps, feature. */}
        <div className="mt-6 grid grid-cols-1 gap-5 @3xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] @3xl:grid-rows-[auto_1fr] @3xl:gap-x-7">
          <div className="min-w-0 space-y-5 @3xl:col-start-2 @3xl:row-start-1">
            <section className="rounded-[var(--r-2)] border border-red-500/25 bg-red-500/[0.06] p-5" data-testid="update-error-panel">
              {failure.step && (
                <SubHeading className="m-0 mb-2 flex items-center gap-2 font-display text-[19px] font-semibold text-red-300">
                  <span className="material-symbols-rounded shrink-0" aria-hidden="true" style={{ fontSize: 21 }}>error</span>
                  <span className="min-w-0 break-words">{failure.step.label}</span>
                </SubHeading>
              )}
              {downgrade && state ? (
                <HarnessDowngradeNotice
                  detail={downgrade}
                  kind="update"
                  backupFailure={state.errorCode === HARNESS_DOWNGRADE_BACKUP_FAILED_CODE ? downgrade.backupFailure ?? "" : undefined}
                  onOverride={onOverrideDowngrade}
                />
              ) : (
                <>
                  <p className="m-0 flex items-start gap-2 text-[13px] leading-relaxed text-[var(--text-secondary)]" data-testid="update-error-reason">
                    {!failure.step && (
                      <span className="material-symbols-rounded shrink-0 text-red-300" aria-hidden="true" style={{ fontSize: 20 }}>error</span>
                    )}
                    <span className="min-w-0 break-words">{failure.reason ?? noReason}</span>
                  </p>
                  {failure.context && (
                    <p className="m-0 mt-2 break-words text-xs leading-relaxed text-[var(--text-muted)]" data-testid="update-error-context">
                      {failure.context}
                    </p>
                  )}
                </>
              )}
              <div className="mt-[18px] flex flex-wrap items-center gap-2.5">
                {onResume && (
                  <button
                    type="button"
                    onClick={onResume}
                    className="inline-flex items-center gap-2 rounded-[var(--r-1)] bg-[var(--coral-bright)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--coral-mid)] cursor-pointer"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>refresh</span>
                    {/* The step is known when one is marked failed: the run picks
                        up there. With none known a fresh run is what "again" means. */}
                    {failure.step
                      ? tr("update.resume", "Resume update")
                      : tr("update.startAgain", "Start the update again")}
                  </button>
                )}
                {dismissButton}
              </div>
              {dismissRefusal}
            </section>

            {ran.length > 0 && (
              <section
                aria-label={tr("update.updateLog", "Update log")}
                className="rounded-[var(--r-2)] border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-5 font-mono text-xs text-[var(--text-secondary)]"
                data-testid="update-log"
              >
                <div className="mb-2 flex justify-between gap-3 border-b border-[var(--border-subtle)] pb-2 text-gray-300" aria-hidden="true">
                  <span>{tr("update.updateLog", "Update log")}</span>
                  <span className="tabular-nums">{completedCount} / {steps.length}</span>
                </div>
                <ol className="m-0 list-none p-0">
                  {ran.map(({ step, index, shown }) => {
                    // The step the run stopped at carries the reason the panel
                    // gives; any other failed step only its own. A refused
                    // downgrade's English is never written here.
                    const reason = shown !== "failed" || downgrade
                      ? null
                      : step === failure.step ? failure.reason : stepFailureReason(step);
                    return (
                      <li key={step.id} className="flex min-w-0 gap-3 py-[3px] leading-relaxed">
                        <span className="shrink-0 text-[var(--text-muted)]">{stepNumber(index)}</span>
                        {shown === "completed" ? (
                          <span className="min-w-0">
                            <span className="text-[var(--cyan-bright)]" aria-hidden="true">✓</span> {step.label}
                          </span>
                        ) : (
                          <span className="min-w-0 break-words text-red-300">
                            <span aria-hidden="true">×</span> {reason ? `${step.label}: ${reason}` : step.label}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

          </div>

          <div className="min-w-0 space-y-4 @3xl:col-start-1 @3xl:row-span-2 @3xl:row-start-1">
            {stepsPanel}
            {warningList}
            {agentVersions}
          </div>

          {whatsNew.settled && (
            <div className="min-w-0 self-start @3xl:col-start-2 @3xl:row-start-2">
              <UpdateWhatsNewPanel panel={panel} variant="compact" headingLevel={SubHeading} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const bar: RunNotice | null = notice
    ?? (status === "updating"
      ? { icon: "power_settings_new", title: tr("update.heroUpdatingSub", "Don't power off until this finishes."), note: tr("update.reconnectNote", "Your ClawBox will briefly go offline while restarting. This page reconnects automatically.") }
      : restarts
        ? { icon: "restart_alt", title: tr("update.reloadOnRestart", "The page will reload once the device is back up."), note: null }
        : null);
  const warn = bar?.tone === "warn";

  return (
    <div className="@container w-full" data-testid="update-run" data-status={status}>
      <div className="grid grid-cols-1 gap-8 @3xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-[18px]">
          {header}
          {versionRow}
          {stepsPanel}
          {warningList}
          {status === "completed" && <div>{dismissButton}{dismissRefusal}</div>}
          {agentVersions}
        </div>
        <div className="min-w-0">
          {whatsNew.settled && <UpdateWhatsNewPanel panel={panel} variant="grid" headingLevel={SubHeading} />}
        </div>
      </div>
      {/* While the run is live it is held to the bottom of the window as the
          steps scroll under it: "don't power off" is the one line that must
          stay in sight. A finished run's restart note sits in the flow, over
          nothing. */}
      {bar && (
        <div
          className={`${status === "updating" ? "sticky bottom-4 z-10 shadow-[0_-8px_24px_rgba(0,0,0,0.25)]" : ""} mt-7 flex items-center gap-3 rounded-[10px] border ${warn ? "border-amber-500/40" : "border-[var(--border-subtle)]"} bg-[var(--bg-surface)] px-5 py-4 text-xs text-[var(--text-secondary)]`}
          data-testid="update-run-notice"
          data-tone={warn ? "warn" : undefined}
          aria-live="polite"
        >
          <span className={`material-symbols-rounded shrink-0 ${warn ? "text-amber-300" : "text-orange-400"}`} aria-hidden="true" style={{ fontSize: 21 }}>{bar.icon}</span>
          <div className="min-w-0">
            <p className={`m-0 font-medium ${warn ? "text-amber-100" : "text-gray-300"}`}>{bar.title}</p>
            {bar.note && <p className="m-0 mt-1 text-[11px]">{bar.note}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
