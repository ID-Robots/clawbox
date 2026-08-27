/**
 * One child-process wrapper for the coding agent's `git` and `gh` calls, and
 * one set of rules for reading what it gives back.
 *
 * WHY THIS FILE EXISTS
 *
 * `code === null` is ambiguous, and the ambiguity is expensive. A child killed
 * by SIGKILL closes with a null code; a child that never started resolves with
 * a null code too. Reading the second meaning into the first told owners to
 * install a `gh` that was already on the box (#518), and — in the git twin of
 * the same wrapper — turned "this folder belongs to another repository, refuse"
 * into `git init` inside somebody else's tracked tree.
 *
 * Two facts settle it, and neither can be recovered from the exit code:
 *
 *   - `spawn` fires only when the process really started. It is the only thing
 *     separating "never ran" from "ran and then something went wrong" — `error`
 *     also fires on a perfectly healthy child whose kill() could not deliver a
 *     signal.
 *   - the spawn errno separates ENOENT (genuinely missing) from EACCES (right
 *     there, wrong mode bits). Collapsing them offers the one remedy that
 *     cannot help.
 *
 * Both callers used to carry their own copy of this. coding-github.ts was
 * fixed; coding-git.ts kept the pre-fix copy. Sharing the wrapper is what stops
 * the next fix landing in one of two identical paths.
 */

import { spawn } from "child_process";

export interface ChildResult {
  /** The exit code, or null when the process was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The signal that killed it, when one did. */
  signal: NodeJS.Signals | null;
  /** True when OUR timer killed it: the command outlived its budget. */
  timedOut: boolean;
  /** True when the binary could not be started at all. Necessary evidence that
   *  the command is unusable, but NOT sufficient to call it absent — see
   *  startError. */
  startFailed: boolean;
  /** The errno of a failed spawn: ENOENT means genuinely missing, EACCES means
   *  present but not executable. */
  startError: string | null;
}

export interface RunChildOptions {
  cwd?: string;
  timeoutMs: number;
  /** The whole environment the child gets — deliberately built by the caller,
   *  because git and gh need different things and neither needs the server's. */
  env: Record<string, string>;
  /** What stderr reads when the binary never started. */
  notStarted?: string;
}

/**
 * Run a command with a deliberate, minimal environment and a hard timeout.
 * Never rejects: every outcome is described in the result.
 */
export function runChild(bin: string, args: string[], opts: RunChildOptions): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      // Cast only because this repo's ProcessEnv augmentation insists on
      // NODE_ENV, which neither git nor gh has any use for.
      env: opts.env as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    timer.unref();
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    // `error` is not proof the binary is missing. It also fires on a child that
    // spawned perfectly well and whose kill() could not deliver its signal — so
    // treating every error as "not installed" would reintroduce the exact
    // false-failure this module exists to prevent, on the timeout path of all
    // places.
    let spawned = false;
    child.on("spawn", () => { spawned = true; });
    // A failed spawn emits `error` and THEN `close` with a null code; the first
    // resolve wins, so this is the one place startFailed is set.
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: spawned ? stderr.trim() : (opts.notStarted ?? "could not start"),
        signal: null,
        timedOut,
        startFailed: !spawned,
        startError: spawned ? null : (err?.code ?? null),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), signal, timedOut, startFailed: false, startError: null });
    });
  });
}

/** True when the command ran but produced no exit code — it was killed, by our
 *  own timer or by something else. It started, so the binary exists. */
export function wasKilled(r: ChildResult): boolean {
  return !r.startFailed && r.code === null;
}

/**
 * True when the result carries NO finding about the world: the command either
 * never started or was cut short. A non-zero exit code is a finding; this is
 * the absence of one, and acting on it is guessing.
 */
export function inconclusive(r: ChildResult): boolean {
  return r.startFailed || wasKilled(r);
}

/**
 * ENOENT is the only errno that means "there is no such file". Anything else —
 * EACCES above all — is a binary that EXISTS and would not run.
 *
 * A spawn error with NO errno is not evidence of absence either. It is the
 * absence of evidence, and this module's whole subject is not confusing the
 * two: the pre-#518 code guessed "missing" from a bare null exit code, and
 * folding `startError === null` in here would have kept that same guess alive
 * one layer down, with the same wrong remedy attached. So: ENOENT, or nothing.
 */
export function startedMissing(r: ChildResult): boolean {
  return r.startFailed && r.startError === "ENOENT";
}

/**
 * What to say about a binary that would not start, claiming exactly as much as
 * the errno supports and no more.
 *
 * Three cases, three different remedies, and the third one names both because
 * an unrecognised errno tells us only that the command did not run. Naming a
 * single remedy there would be a guess — and the guess this code used to make
 * was "go and install it".
 */
export function startFailureDetail(r: ChildResult, name: string): string {
  if (r.startError === "ENOENT") return `${name} is not installed on this ClawBox.`;
  if (r.startError === "EACCES" || r.startError === "EPERM") {
    return `${name} is on this ClawBox but would not start (${r.startError}). Check its permissions.`;
  }
  return `${name} would not start${r.startError ? ` (${r.startError})` : ""}. Check that it is installed and that it can be executed.`;
}

/**
 * What to tell the owner about a call that was cut short. Never mentions
 * installing anything: the binary demonstrably ran. Never blank either — a
 * SIGKILLed child writes no stderr, so a `(stderr || stdout)` detail for a
 * killed call was the empty string, and the surfaces that render
 * `detail ?? reason` showed the owner a failure with nothing in it.
 */
export function killedDetail(
  r: ChildResult,
  what: string,
  advice = "Check this ClawBox's network connection and try again.",
): string {
  const how = r.timedOut ? "timed out" : `was stopped before it finished${r.signal ? ` (${r.signal})` : ""}`;
  return `${what} ${how}. ${advice}`;
}

/**
 * The detail for ANY failed call, killed or not. The rule the residuals kept
 * breaking in one branch at a time: read the published evidence, never the
 * exit code alone, and never hand back an empty string.
 */
export function failureDetail(r: ChildResult, what: string, advice = "Try again."): string {
  // A failed spawn was never "stopped before it finished" — it never began.
  if (r.startFailed) return `${what} could not be started (${r.startError ?? "unknown error"}). ${advice}`;
  if (wasKilled(r)) return killedDetail(r, what, advice);
  return (r.stderr || r.stdout || `${what} failed.`).slice(0, 400);
}
