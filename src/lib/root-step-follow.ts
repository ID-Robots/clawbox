/**
 * Start a root install step and follow it to the end, line by line.
 *
 * The web server may start `install.sh --step <name>` as root only through the
 * launcher in root-step-runner.ts, and `--no-block` returns before the unit has
 * done anything. What a route that wants to SHOW the install needs is the rest:
 * poll systemd for the unit's state, tail its journal for the last line, and
 * say whether it ended well. The llama.cpp install route carries this loop
 * inline; this is the same loop for the next caller (the on-device voice).
 *
 * SERVER ONLY: runs systemctl and journalctl.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { startRootStep } from "@/lib/root-step-runner";
import { DISPATCH_VERDICT_LINE, rootStepJournalArgs, rootStepUnit } from "@/lib/root-step-journal";

const execFile = promisify(execFileCb);

const SYSTEMCTL_QUERY_TIMEOUT_MS = 15_000;
const POLL_MS = 3000;
/** `systemctl start --no-block` returns before the unit leaves "inactive". */
const START_GRACE_MS = 1000;
const START_GRACE_POLLS = 2;

export interface FollowRootStepOptions {
  /** How long the whole step may take before it is reported as timed out. */
  timeoutMs: number;
  /** Every new last line of the unit's journal, as it appears. */
  onStatus: (line: string) => void;
  /** What to call the step in the messages nobody else wrote. */
  label: string;
  /**
   * Once, when the unit is first seen running: which run of the step this is.
   * A background task records it (src/lib/background-tasks.ts), so a web
   * server that restarts while the unit runs on under systemd can follow the
   * same run again instead of calling it lost.
   */
  onRunning?: (run: RootStepRun) => void;
}

/** One run of a root step, as a later reader needs it to find that run again. */
export interface RootStepRun {
  step: string;
  /** When the run was dispatched — the journal window's start (root-step-journal.ts). */
  sinceMs: number;
  /**
   * systemd's id for the run, read while the instance is loaded (it is
   * collected as it exits, see root-step-journal.ts). Null when it was not
   * read before the follow ended.
   */
  invocationId: string | null;
}

export interface FollowRootStepResult {
  ok: boolean;
  error?: string;
  /**
   * Only from {@link followRootStepRun}: the run could not be found again — it
   * was never seen running, or the unit now runs another invocation — so
   * nothing is known about how it ended.
   */
  lost?: boolean;
}

/**
 * The unit's invocation while it is loaded. A separate query from
 * {@link unitState}, asked once per follow, rather than a third property on
 * every poll.
 */
async function unitInvocation(unit: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", unit, "-p", "InvocationID"],
      { timeout: SYSTEMCTL_QUERY_TIMEOUT_MS },
    );
    const id = /^InvocationID=([0-9a-f]{32})$/im.exec(stdout)?.[1];
    return id ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function unitState(unit: string): Promise<{ active: string; result: string }> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", unit, "-p", "ActiveState", "-p", "Result"],
      { timeout: SYSTEMCTL_QUERY_TIMEOUT_MS },
    );
    return {
      active: /^ActiveState=(.*)$/m.exec(stdout)?.[1]?.trim() || "",
      result: /^Result=(.*)$/m.exec(stdout)?.[1]?.trim() || "",
    };
  } catch {
    return { active: "", result: "" };
  }
}

/**
 * What THIS run of the step has said so far.
 *
 * Bounded by `sinceMs`, the moment this follow started it: the journal is
 * persistent, so an unbounded read hands the last attempt's lines to a caller
 * that is showing them as live progress — and the poll before the unit writes
 * anything is exactly when that happens. A second install of the voice would
 * open by showing the first one's error.
 */
async function journalLines(
  step: string,
  sinceMs: number,
  lines: number,
  // Keep the LEADING whitespace. install.sh's two-space indent is the only
  // thing separating its own sub-phase headlines from the pip/apt output
  // underneath them, so the progress watcher below has to read them untrimmed.
  // Everything else wants them trimmed: `failureReason`'s marker regex is
  // `^`-anchored, and an indented line would slip past it.
  { keepIndent = false }: { keepIndent?: boolean } = {},
): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      rootStepJournalArgs(step, { sinceMs, lines }),
      { timeout: 10_000 },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => (keepIndent ? l.replace(/\s+$/, "") : l.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function lastJournalLine(step: string, sinceMs: number, lines: number): Promise<string | null> {
  const all = await journalLines(step, sinceMs, lines);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** How often a watched step's journal is re-read for a new headline. */
const PROGRESS_POLL_MS = 4000;
/** How far back each poll looks; enough to span a chatty pip install. */
const PROGRESS_WINDOW_LINES = 60;

/**
 * install.sh's own progress lines, told apart from the noise underneath them.
 *
 * The installer announces each sub-phase with a two-space indent — "  Installing
 * Kokoro TTS...", "  Building CTranslate2 with CUDA for sm_87..." — while the
 * tools it drives write flush left ("Installing collected packages: ...",
 * "Successfully installed av-17.1.0 ..."). That indent is the only marker there
 * is, and it is enough: it is applied consistently by every step, and matching
 * it means a caller shows the box's own account of what it is doing rather than
 * pip's.
 *
 * Deliberately NOT the last journal line, which is what `followRootStep` streams:
 * during the CUDA compile the last line is whatever cc1plus last said, and for
 * six minutes there is no line at all. The headline is what stays true.
 */
const HEADLINE_RE = /^ {2}(\S.*)$/;

/**
 * Watch a root step that someone ELSE is running, and report what it is doing.
 *
 * Read-only on purpose. `followRootStep` above both STARTS a step and follows
 * it, which suits a route that owns the install; the updater does not want that
 * — its root steps carry their own budgets, overrun handling and gateway
 * quiescing, and swapping how they are started to get progress out would put
 * all of that at risk for a cosmetic gain. This only reads the journal.
 *
 * Returns the stopper. Safe to call after the step has ended.
 */
export function watchRootStepProgress(
  step: string,
  sinceMs: number,
  onHeadline: (headline: string) => void,
): () => void {
  let stopped = false;
  let last: string | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;

  void (async () => {
    while (!stopped) {
      const lines = await journalLines(step, sinceMs, PROGRESS_WINDOW_LINES, { keepIndent: true });
      // Checked HERE, once, rather than by every caller: a read already in
      // flight when the watch was stopped resolves after it, and this is what
      // makes "no headline after stop()" the watcher's own guarantee instead of
      // something each listener has to defend against.
      if (stopped) return;

      let newest: string | null = null;
      for (const line of lines) {
        const headline = HEADLINE_RE.exec(line)?.[1];
        if (headline) newest = headline;
      }
      if (newest && newest !== last) {
        last = newest;
        // A throwing listener must not end the watch, nor bubble into the step.
        try { onHeadline(newest); } catch { /* nobody listening */ }
      }

      await new Promise<void>((resolve) => { sleepTimer = setTimeout(resolve, PROGRESS_POLL_MS); });
    }
  })();

  return () => {
    stopped = true;
    // Or the step's last sleep keeps a timer alive for four more seconds — 13
    // root steps' worth per update, and enough to hold the event loop open just
    // as the rebuild step wants to take the process down.
    if (sleepTimer) clearTimeout(sleepTimer);
  };
}

/**
 * The line that says WHY a failed step failed. install.sh's dispatch trap
 * prints a banner and two `[provision-…]` markers after the real error, so
 * the last line of the journal is a run id, never the reason. Prefer the last
 * line that names an error or the engine; else the last line that is not a
 * marker; else nothing.
 */
export function failureReason(lines: readonly string[]): string | null {
  const said = lines.filter((line) => !DISPATCH_VERDICT_LINE.test(line));
  const telling = [...said].reverse().find((line) => /error|kokoro/i.test(line));
  return telling ?? (said.length > 0 ? said[said.length - 1] : null);
}

async function failureLine(step: string, sinceMs: number): Promise<string | null> {
  return failureReason(await journalLines(step, sinceMs, 40));
}

function running(active: string): boolean {
  return active === "activating" || active === "active" || active === "reloading";
}

export async function followRootStep(step: string, opts: FollowRootStepOptions): Promise<FollowRootStepResult> {
  // Before the start, so nothing this run writes falls outside the window the
  // journal reads below are bounded by.
  const startedAt = Date.now();
  try {
    await startRootStep(step, { noBlock: true, timeoutMs: SYSTEMCTL_QUERY_TIMEOUT_MS });
  } catch (err) {
    const line = await lastJournalLine(step, startedAt, 40);
    return { ok: false, error: line || (err instanceof Error ? err.message : `Could not start ${opts.label}.`) };
  }
  return followLoop({ step, sinceMs: startedAt, invocationId: null }, opts, false);
}

/**
 * Follow a run somebody ELSE dispatched — a previous web server process, which
 * recorded it through `onRunning` — to its end. Starts nothing.
 *
 * It only claims an ending it can tie to that run. A unit running ANOTHER
 * invocation now, or a run that was never seen running (no invocation was
 * recorded and the unit is not running), answers `lost`: the run may have
 * ended either way, and the caller says it does not know rather than
 * guessing. A run that was seen running and is now inactive ended the way
 * {@link followRootStep} reads every ending — `failed` stays loaded and says
 * so; a clean exit is collected and reads as inactive.
 */
export async function followRootStepRun(
  run: RootStepRun,
  opts: Omit<FollowRootStepOptions, "onRunning">,
): Promise<FollowRootStepResult> {
  return followLoop(run, opts, true);
}

async function followLoop(
  run: RootStepRun,
  opts: FollowRootStepOptions,
  adopted: boolean,
): Promise<FollowRootStepResult> {
  const { step, sinceMs: startedAt } = run;
  const unit = rootStepUnit(step);
  const deadline = Date.now() + opts.timeoutMs;
  let lastLine: string | null = null;
  // An adopted run that carries its invocation WAS seen running by whoever
  // dispatched it, so an inactive unit now is its ending, not a slow start.
  let sawRunning = adopted && run.invocationId !== null;
  let invocationKnown = false;
  let gracePolls = 0;

  while (Date.now() < deadline) {
    const { active, result } = await unitState(unit);
    if (running(active)) {
      sawRunning = true;
      // Once: the first time the unit is seen running is the only moment a new
      // invocation could have taken its place (a 3 s poll cannot miss a whole
      // run ending and another starting in between otherwise).
      if (!invocationKnown) {
        invocationKnown = true;
        const current = await unitInvocation(unit);
        if (adopted && run.invocationId !== null && current !== null && current !== run.invocationId) {
          return { ok: false, lost: true, error: `${opts.label} was started again since; this run's ending is not known.` };
        }
        if (run.invocationId === null && current !== null) {
          try {
            opts.onRunning?.({ step, sinceMs: startedAt, invocationId: current });
          } catch { /* a recorder that broke must not end the follow */ }
        }
      }
    } else if (adopted && !sawRunning) {
      return { ok: false, lost: true, error: `${opts.label} is not running any more, and how it ended was not recorded.` };
    }

    const line = await lastJournalLine(step, startedAt, 5);
    if (line && line !== lastLine) {
      lastLine = line;
      // A listener that is gone (the stream's client cancelled) must not
      // end the follow: the root unit runs on regardless, and whoever holds
      // the "one install at a time" flag needs its real end.
      try { opts.onStatus(line); } catch { /* nobody listening */ }
    }

    if (active === "failed") {
      return { ok: false, error: (await failureLine(step, startedAt)) || `${opts.label} failed (${result || "unknown"})` };
    }

    if (!running(active)) {
      if (sawRunning || gracePolls >= START_GRACE_POLLS) {
        if (result && result !== "success") {
          return { ok: false, error: (await failureLine(step, startedAt)) || `${opts.label} failed (${result})` };
        }
        return { ok: true };
      }
      gracePolls += 1;
      await new Promise((resolve) => setTimeout(resolve, START_GRACE_MS));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return { ok: false, error: lastLine || `Timed out waiting for ${opts.label}.` };
}
