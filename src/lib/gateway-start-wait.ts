import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * Waiting for a gateway that is STARTING, as opposed to giving up on one.
 *
 * The updater used to give the gateway's port one flat window after its
 * restart (45 s) and then call the update failed: "OpenClaw gateway is not
 * listening on port 18789". On a box with large agent databases that window is
 * shorter than an ordinary start — the pre-start's database housekeeping alone
 * is budgeted for minutes (gateway-pre-start.sh), and a gateway with a few GB
 * of memory index was measured listening ~55 s after its restart — so the
 * owner got a red X over an update that had worked, and a gateway that was
 * healthy minutes later.
 *
 * Port closed is not the same as gateway dead, and systemd says which one it
 * is. This keeps probing the port, and between probes asks the unit: while it
 * is `activating` (pre-start, auto-restart), `active` but not listening yet, or
 * has a job pending, it is still starting and the wait goes on, up to a limit
 * the caller sets (the unit's own 600 s start ceiling). It ends early only on a
 * real failure: the unit `failed`, the unit stopped with nothing queued to
 * start it, or a crash loop — systemd restarting it again and again while the
 * port never opened.
 *
 * Probing is the caller's (`waitForPort`), so the port check stays the one the
 * rest of the updater uses. The unit is asked at a backing-off interval: a
 * loopback connect costs nothing, a `systemctl show` on a box busy starting a
 * gateway does.
 */

/** What systemd says about the gateway unit, read in one `systemctl show`. */
export interface GatewayStartState {
  activeState: string;
  subState: string;
  result: string;
  /** Empty when no job is pending. */
  job: string;
  /** systemd's automatic-restart counter, or null when it did not say. */
  restarts: number | null;
}

export type GatewayStartFailure =
  /** The unit is `failed`: a start limit, a refused config (exit 78). */
  | "unit-failed"
  /** The unit is `inactive` with no job queued to start it. */
  | "unit-stopped"
  /** systemd restarted it `crashLoopRestarts` times while the port stayed shut. */
  | "crash-loop"
  /** systemd could not be asked, and the caller would not wait on a guess. */
  | "unconfirmed";

export type GatewayStartVerdict =
  | { kind: "listening"; waitedMs: number }
  | { kind: "failed"; reason: GatewayStartFailure; state: GatewayStartState | null; waitedMs: number; restarts: number }
  | { kind: "timed-out"; state: GatewayStartState | null; waitedMs: number };

export interface GatewayStartWaitOptions {
  /** Probe the port for up to `ms`; true as soon as it answers. */
  waitForPort: (ms: number) => Promise<boolean>;
  readState: () => Promise<GatewayStartState | null>;
  /**
   * The port alone, before systemd is asked anything: the window the caller
   * always had, so a gateway that starts quickly is handled exactly as before.
   */
  firstWindowMs: number;
  /** The whole wait, first window included. */
  limitMs: number;
  /** The first gap between unit reads after the first window; grows by half each time. */
  pollMs: number;
  /** The longest that gap grows to. */
  maxPollMs: number;
  /**
   * Whether a unit systemd will not describe counts as still starting. True
   * right after this process restarted it and systemd took the restart; false
   * for a health check before any restart, where "could not look" is no
   * evidence of a start and the caller goes on to its repair as it always did.
   */
  unknownIsStarting: boolean;
  /** Automatic restarts during the wait that make it a crash loop. */
  crashLoopRestarts?: number;
  /** Told on every round the gateway is still starting. */
  onStillStarting?: (state: GatewayStartState | null, waitedMs: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const GATEWAY_CRASH_LOOP_RESTARTS = 3;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_POLL_MS = 15_000;

/** Where the unit is in its start, as far as the wait is concerned. */
export function gatewayStartPhase(state: GatewayStartState | null): "starting" | "failed" | "stopped" | "unknown" {
  if (!state) return "unknown";
  if (state.activeState === "failed") return "failed";
  // `inactive` with a start job queued is a start that has not begun yet.
  if (state.activeState === "inactive") return state.job ? "starting" : "stopped";
  // activating (start-pre, start, auto-restart), active (up, not listening
  // yet), reloading, deactivating (the previous process still draining, with
  // a restart behind it): all of them are systemd still moving the unit.
  return "starting";
}

export async function waitForGatewayStart(options: GatewayStartWaitOptions): Promise<GatewayStartVerdict> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const crashLoopRestarts = options.crashLoopRestarts ?? GATEWAY_CRASH_LOOP_RESTARTS;
  const started = now();
  const elapsed = () => now() - started;
  // A bound that is not a number (an unparsable env override) must not make
  // the wait endless, nor a NaN gap turn it into a spin of `systemctl show`:
  // no limit means no extension past the first window, no gap the defaults.
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const firstWindowMs = Math.max(0, finite(options.firstWindowMs, 0));
  const limitMs = Math.max(firstWindowMs, finite(options.limitMs, firstWindowMs));
  const maxPollMs = Math.max(1, finite(options.maxPollMs, DEFAULT_MAX_POLL_MS));

  // A probe that answers early with "closed" (a test double, a refused
  // connect) must not turn the wait into a spin: every round lasts its length.
  const portRound = async (ms: number): Promise<boolean> => {
    const roundStarted = now();
    if (await options.waitForPort(ms)) return true;
    const left = ms - (now() - roundStarted);
    if (left > 0) await sleep(left);
    return false;
  };

  if (await portRound(firstWindowMs)) return { kind: "listening", waitedMs: elapsed() };

  let pollMs = Math.min(maxPollMs, Math.max(1, finite(options.pollMs, DEFAULT_POLL_MS)));
  let lastCount: number | null = null;
  let restarts = 0;
  let stoppedReads = 0;
  let last: GatewayStartState | null = null;
  for (;;) {
    const state = await options.readState();
    if (state) last = state;
    const phase = gatewayStartPhase(state);

    if (phase === "unknown" && !options.unknownIsStarting) {
      return { kind: "failed", reason: "unconfirmed", state: null, waitedMs: elapsed(), restarts };
    }
    // Two reads in a row, one round apart: a single answer caught between two
    // of systemd's own transitions is not a verdict on the start.
    if (phase === "failed" || phase === "stopped") {
      stoppedReads += 1;
      if (stoppedReads >= 2) {
        return {
          kind: "failed",
          reason: phase === "failed" ? "unit-failed" : "unit-stopped",
          state,
          waitedMs: elapsed(),
          restarts,
        };
      }
    } else {
      stoppedReads = 0;
    }
    if (typeof state?.restarts === "number") {
      // Counted from the first answer, never from zero: the counter covers the
      // unit's life. A count that went DOWN was reset by a manual start under
      // the wait, and everything it says now happened since.
      if (lastCount !== null) restarts += state.restarts >= lastCount ? state.restarts - lastCount : state.restarts;
      lastCount = state.restarts;
      if (restarts >= crashLoopRestarts) {
        return { kind: "failed", reason: "crash-loop", state, waitedMs: elapsed(), restarts };
      }
    }

    const remaining = limitMs - elapsed();
    if (remaining <= 0) return { kind: "timed-out", state: last, waitedMs: elapsed() };
    // Not while a failed or stopped unit waits for its second read: that is
    // not a start, and the screen must not call it one.
    if (stoppedReads === 0) options.onStillStarting?.(state, elapsed());
    if (await portRound(Math.min(pollMs, remaining))) return { kind: "listening", waitedMs: elapsed() };
    pollMs = Math.min(maxPollMs, Math.round(pollMs * 1.5));
  }
}

/** "1 min 20 s", "45 s": how long the owner has been waiting, in words. */
export function formatWaited(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/**
 * The line the update screen shows under its running step while the gateway
 * is still starting: what systemd says it is doing, and for how long. A
 * spinner with no words over a ten-minute start reads as a hang.
 */
export function describeStillStarting(state: GatewayStartState | null, waitedMs: number): string {
  const sofar = `${formatWaited(waitedMs)} so far`;
  if (state?.activeState === "activating" && state.subState === "start-pre") {
    return `Gateway still starting: running its start-up checks (${sofar})`;
  }
  if (state?.activeState === "activating" && state.subState === "auto-restart") {
    return `Gateway still starting: restarting (${sofar})`;
  }
  if (state?.activeState === "deactivating" || (state?.activeState === "inactive" && state.job)) {
    return `Gateway still starting: waiting for the previous one to stop (${sofar})`;
  }
  if (state?.activeState === "active") {
    return `Gateway still starting: loading its data, large memory databases take a few minutes (${sofar})`;
  }
  return `Gateway still starting: waiting for it to answer (${sofar})`;
}

/**
 * The unit's state for {@link waitForGatewayStart}, or null when systemctl
 * could not be asked. `readUnitState` (`@/lib/gateway-unit-job`) plus the
 * restart counter, which is what tells a crash loop from a slow start; the
 * result is a `UnitState` too, so `describeUnitState` reads it.
 */
export async function readGatewayStartState(unit: string): Promise<GatewayStartState | null> {
  try {
    const { stdout } = await exec(
      "/usr/bin/systemctl",
      [
        "show", unit,
        "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "Job", "-p", "NRestarts",
        "--no-pager",
      ],
      { timeout: 10_000 },
    );
    const shown: Record<string, string> = {};
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const split = line.indexOf("=");
      if (split > 0) shown[line.slice(0, split).trim()] = line.slice(split + 1).trim();
    }
    if (!shown.ActiveState) return null;
    const restarts = /^\d+$/.test(shown.NRestarts ?? "") ? Number(shown.NRestarts) : null;
    return {
      activeState: shown.ActiveState,
      subState: shown.SubState ?? "",
      result: shown.Result ?? "",
      job: shown.Job ?? "",
      restarts,
    };
  } catch {
    return null;
  }
}
