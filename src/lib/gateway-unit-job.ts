import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * A systemd job that outlives the client that asked for it.
 *
 * `systemctl restart|stop` blocks until systemd has finished the JOB, and the
 * job does not end when the client is killed: systemd finishes it regardless.
 * Every ClawBox caller bounds that client (60 s for a restart, 5 s for a
 * restore that only asks, 30 s or less for a stop), and on an x64 bridge
 * install that bound is shorter than the stop itself. The bridge's ExecStop is `systemctl --user stop openclaw-gateway`,
 * which waits for OpenClaw's own drain: the user unit OpenClaw renders carries
 * TimeoutStopSec=330 and the gateway caps its drain at 315 s for it
 * (docs/cli/gateway/restart-and-supervision.md, OpenClaw 2026.10.3). Node then
 * killed the client at its deadline, the caller reported "Command failed", and
 * the restart landed minutes later anyway (an x64 bridge install, 2026-10-15:
 * three times, each exactly 60 s after the call, each finished about five
 * minutes later).
 *
 * So a client killed by its OWN timeout is not a failed job; it is a job in
 * flight. What finished it is read off the unit: no `Job` left, and the
 * `ActiveState` it settled in. Never off the gateway port alone: while it
 * drains, the OLD gateway still listens there, so a port probe would call a
 * process on its way out the gateway being back.
 *
 * Any other failure (a non-zero exit, a refused sudo, a masked unit) is still
 * the caller's to read and is rethrown untouched.
 */

/** The unit as systemd reports it now. `job` is empty when nothing is pending. */
export interface UnitState {
  job: string;
  activeState: string;
  subState: string;
  result: string;
}

export type UnitJobOutcome =
  /** The client returned: systemd answered the job's own result. */
  | { kind: "returned" }
  /** The client was killed by its deadline and the job has since finished. */
  | { kind: "settled"; state: UnitState; waitedMs: number }
  /** The client was killed and the job was still pending at the budget. */
  | { kind: "in-flight"; state: UnitState | null; waitedMs: number };

export interface UnitJobOptions {
  unit: string;
  /** Ask the calling user's manager (`systemctl --user`) about the unit. */
  user?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The client's own bound, as before. */
  timeoutMs: number;
  /** How long a job in flight is waited for once the client was killed. */
  settleBudgetMs?: number;
  pollMs?: number;
}

/**
 * How long a job the client gave up on is waited for by a caller nobody is
 * waiting on (the updater): OpenClaw's stop budget (330 s) plus half a minute
 * for the start that follows it. A caller answering a request passes a short
 * `settleBudgetMs` instead (the factory reset, a settings save): a tunnel
 * gives up near 100 s, and "still restarting" is then the honest answer.
 */
export const UNIT_JOB_SETTLE_BUDGET_MS = 360_000;
const UNIT_JOB_POLL_MS = 2_000;
const UNIT_SHOW_TIMEOUT_MS = 10_000;

/**
 * Raised when a restart job finished and the unit did not come back active.
 * A real failure, said in plain words: the caller still reports it as one.
 */
export class GatewayRestartFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRestartFailedError";
  }
}

/**
 * Node's own timeout kill: `killed` set, a signal, and no exit code. A
 * maxBuffer overflow also kills the child and carries a string `code`, so it
 * is not mistaken for one.
 */
export function clientTimedOut(err: unknown): boolean {
  const failure = err as { killed?: unknown; signal?: unknown; code?: unknown } | null;
  return failure?.killed === true && typeof failure.signal === "string" && typeof failure.code !== "string";
}

/** The unit's job and state, or null when systemctl could not be asked. */
export async function readUnitState(
  unit: string,
  options: { user?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<UnitState | null> {
  try {
    const { stdout } = await exec(
      options.user ? "systemctl" : "/usr/bin/systemctl",
      [
        ...(options.user ? ["--user"] : []),
        "show", unit, "-p", "Job", "-p", "ActiveState", "-p", "SubState", "-p", "Result", "--no-pager",
      ],
      { timeout: UNIT_SHOW_TIMEOUT_MS, ...(options.env ? { env: options.env } : {}) },
    );
    const shown: Record<string, string> = {};
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const split = line.indexOf("=");
      if (split > 0) shown[line.slice(0, split).trim()] = line.slice(split + 1).trim();
    }
    if (!shown.ActiveState) return null;
    return {
      job: shown.Job ?? "",
      activeState: shown.ActiveState,
      subState: shown.SubState ?? "",
      result: shown.Result ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Wait until the unit has no job pending, or the budget is spent. A question
 * systemctl does not answer is asked again: "could not look" is not "done".
 */
export async function waitForUnitJob(options: UnitJobOptions): Promise<UnitJobOutcome> {
  const budgetMs = options.settleBudgetMs ?? UNIT_JOB_SETTLE_BUDGET_MS;
  const pollMs = options.pollMs ?? UNIT_JOB_POLL_MS;
  const started = Date.now();
  let last: UnitState | null = null;
  for (;;) {
    const state = await readUnitState(options.unit, options);
    if (state) last = state;
    const waitedMs = Date.now() - started;
    if (state && !state.job) return { kind: "settled", state, waitedMs };
    if (waitedMs >= budgetMs) return { kind: "in-flight", state: last, waitedMs };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, budgetMs - waitedMs)));
  }
}

/**
 * Run one `systemctl restart|stop`, and when the client is killed by its own
 * deadline, wait on the unit's job instead of reporting a failure.
 */
export async function runUnitJob(command: string, args: string[], options: UnitJobOptions): Promise<UnitJobOutcome> {
  try {
    await exec(command, args, { timeout: options.timeoutMs, ...(options.env ? { env: options.env } : {}) });
    return { kind: "returned" };
  } catch (err) {
    if (!clientTimedOut(err)) throw err;
    console.warn(
      `[gateway-unit] ${options.unit}: the client gave up after ${options.timeoutMs} ms; waiting for systemd to finish the job`,
    );
    return waitForUnitJob(options);
  }
}

/**
 * Whether the unit is down: the only states in which something that must not
 * run beside the gateway (a factory-reset wipe, doctor) may start. An
 * allow-list, so `deactivating` (still stopping) and `activating`, `active` or
 * `reloading` (a gateway that is there) all count as not stopped.
 */
export function unitIsStopped(state: UnitState): boolean {
  return state.activeState === "inactive" || state.activeState === "failed";
}

/** "inactive (dead)", "failed (exit-code)": the unit's state as one phrase. */
export function describeUnitState(state: UnitState): string {
  const detail = [state.subState, state.result && state.result !== "success" ? state.result : ""]
    .filter(Boolean)
    .join(", ");
  return detail ? `${state.activeState} (${detail})` : state.activeState;
}
