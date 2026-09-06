import { spawn } from "child_process";
import path from "path";
import { HERMES_BIN } from "@/lib/harness";
import { spawnFailureMessage } from "@/lib/hermes-cli-message";

// Shared helper to run a `hermes` CLI subcommand from a setup-api route.
//
// Every arg is passed as an argv element (spawn with an array, NO shell), so
// route inputs can never inject a command. Callers are still responsible for
// validating any value that could be misread as a FLAG (a value starting with
// "-") — pass those through a strict allowlist/charset first.

const HOME_DIR = process.env.HOME || "/home/clawbox";
const SUDO_BIN = "/usr/bin/sudo";
const DEFAULT_TIMEOUT_MS = 30_000;
// A config/auth command's output is tiny; cap the buffer so a misbehaving
// child can't grow it unbounded.
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Console width for the CLI's `rich` output.
 *
 * Wide enough that no line this repo parses wraps: the widest is a scan-report
 * row (severity + category + `file:line` + a 60-character excerpt, padded to
 * ~110 columns) and a browse table row.
 */
const WIDE_CONSOLE_COLUMNS = "400";

// ── TASK-613: remove once hermes-agent#104275 lands (HERMES_DISABLE_UPDATE_CHECK
// / updates.check) ───────────────────────────────────────────────────────────
//
// `hermes --version` is the only non-interactive hermes call that runs the
// agent's passive update check: in 0.20.5 `banner.check_for_updates()` has
// exactly two call sites — `_startup_fast.py:238`, inside
// `print_fast_version_info`, and `banner.py:646`, the interactive welcome
// banner. Every `config`/`skills`/`plugins`/`approvals` call this file makes is
// already silent, so the silence belongs on that one call and nowhere else.
//
// What the check costs a version probe: an `Update available: N commits behind
// — run 'hermes update'` line appended to the banner we parse (advice that is
// wrong on a device pinned to a commit, whose update path is not `hermes
// update`), and — on every six-hourly cache miss — a synchronous `git fetch
// origin main --depth 1` plus an unauthenticated GitHub compare, each with its
// own 10 s ceiling inside the 10 s budget the probe gives the WHOLE call.
//
// Upstream already has the switch: `print_fast_version_info(*, check_updates:
// bool = True)` returns early at `_startup_fast.py:228-229`. Nothing can reach
// it — all five call sites hard-code True, `banner.py` reads only
// `HERMES_REVISION`, and there is no `updates.*` key for it — so until
// NousResearch/hermes-agent#104275 lands, ask the agent's own printer directly
// through the interpreter the `hermes` shim execs.
//
// Nothing is written by this: `check_for_updates` never runs, so the shared
// ~/.hermes/.update_check cache the OWNER's interactive banner reads is left
// exactly as it was. (Pre-setting `HERMES_REVISION` was the other candidate and
// is the opposite of a silence: it selects the `git ls-remote` branch and is
// part of the cache key, so it would force a miss on every ClawBox probe AND on
// the owner's next banner.)
const HERMES_AGENT_DIR = path.join(HOME_DIR, ".hermes", "hermes-agent");
// The shim is four lines: unset PYTHONPATH, unset PYTHONHOME, exec this
// interpreter on `<agent_dir>/hermes`. install.sh already treats the pair as
// the install's identity (step_hermes_install's `venv_python` guard).
const HERMES_VENV_PYTHON = path.join(HERMES_AGENT_DIR, "venv", "bin", "python");
const SILENT_VERSION_PY =
  "from hermes_cli._startup_fast import print_fast_version_info as v; v(check_updates=False)";
/** The one argv this file knows a silent equivalent for. */
const isSilenceableVersionCall = (args: string[]) => args.length === 1 && args[0] === "--version";

export interface HermesCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HermesCliOptions {
  timeoutMs?: number;
  input?: string;
  // `undefined` REMOVES a variable the server inherited, which is what the
  // silenced version probe needs for PYTHONHOME (see below) — the shim
  // unsets it for the same reason.
  env?: Record<string, string | undefined>;
  /**
   * Kill the child when the caller gives up (a browser that navigated away
   * aborts its fetch, but that alone would leave the process running to its
   * timeout). Optional — callers that don't pass one behave exactly as before.
   *
   * A route may hand this its `request.signal` for a probe, or for the FIRST
   * durable write of the request — cancelling either leaves NOTHING ELSE of
   * that request half-done. It is not a rollback: an abort that lands after
   * the child has already written keeps that write, because all this does is
   * refuse to start (see the guard below) or kill the process. What it buys
   * is that the box is left in one of the two states the request began and
   * ended in, rather than between them.
   *
   * So it must NOT be handed to work that FOLLOWS a durable write: a browser
   * that locked its screen would then leave the token in ClawBox's store and
   * not in Hermes', or a saved channel with a gateway nobody started. Past
   * the first write, finish the job.
   */
  signal?: AbortSignal;
  /**
   * Run the call through `sudo -n`. Only for the handful of subcommands that
   * genuinely need root (`gateway install --system`, which writes a
   * /etc/systemd/system unit). `-n` means a box without a passwordless rule
   * fails immediately instead of blocking on a password prompt — a route
   * handler must never be able to hang on a prompt.
   */
  sudo?: boolean;
  /**
   * TASK-613: remove once hermes-agent#104275 lands
   * (HERMES_DISABLE_UPDATE_CHECK / updates.check).
   *
   * Ask for the call WITHOUT the agent's passive update check. Only
   * `--version` runs one, so this is a no-op for any other argv, and it is
   * ignored under `sudo` — silencing a privileged call by running the
   * interpreter directly would drop the privilege.
   *
   * Fails OPEN: anything that stops the silent form answering (no venv, a
   * renamed module, a changed signature) falls through to the plain call,
   * which behaves exactly as it does on a box without this.
   */
  silenceUpdateCheck?: boolean;
}

export async function runHermesCli(
  args: string[],
  opts: HermesCliOptions = {},
): Promise<HermesCliResult> {
  const bin = opts.sudo ? SUDO_BIN : HERMES_BIN;
  const argv = opts.sudo ? ["-n", HERMES_BIN, ...args] : args;

  if (opts.silenceUpdateCheck && !opts.sudo && isSilenceableVersionCall(args)) {
    const budgetMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    try {
      const quiet = await spawnHermes(HERMES_VENV_PYTHON, ["-c", SILENT_VERSION_PY], {
        ...opts,
        // Half the budget, never more. The silent form does no network at all
        // (measured 853-857 ms on a Hermes box), and whatever it does spend
        // has to leave the fallback enough of the CALLER's deadline to answer
        // — a fix that turns one timeout into two would be worse than the
        // defect it removes.
        timeoutMs: Math.max(1, Math.floor(budgetMs / 2)),
        // The package IS the checkout — there is no pip dist to import — so
        // the checkout goes on the path the shim's `exec <dir>/hermes` would
        // have put there. PYTHONHOME is removed rather than set: an inherited
        // one would send this interpreter at a different stdlib.
        env: { PYTHONPATH: HERMES_AGENT_DIR, PYTHONHOME: undefined, ...opts.env },
      });
      if (quiet.code === 0 && quiet.stdout) return quiet;
    } catch {
      // Fall through to the supported call. Not swallowing an outcome: this
      // path has produced nothing yet, and the call below is the answer.
    }
    return spawnHermes(bin, argv, {
      ...opts,
      timeoutMs: Math.max(1, budgetMs - (Date.now() - started)),
    });
  }

  return spawnHermes(bin, argv, opts);
}

function spawnHermes(
  bin: string,
  argv: string[],
  opts: HermesCliOptions,
): Promise<HermesCliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Already aborted BEFORE the call: nothing may be started. `abort` fires
  // once, so a listener registered below would never hear it and the child
  // would run to completion for a caller that is already gone — the route
  // handlers pass `request.signal`, which aborts the moment the browser
  // disconnects, and the worst case is `ensureHermesGateway` reading the
  // failure as "no gateway here" and going on to `sudo hermes gateway install
  // --system`. Node's own `spawn({ signal })` does not cover this either: on a
  // pre-aborted signal it still spawns and then kills, which for a privileged
  // install is precisely the thing to avoid. Same rejection as `onAbort`, so
  // callers have one message to recognise.
  if (opts.signal?.aborted) return Promise.reject(new Error("hermes call cancelled"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: HOME_DIR,
    PATH: `${path.dirname(HERMES_BIN)}:${process.env.PATH || ""}`,
    // Hermes prints through `rich`, which falls back to 80 columns when
    // stdout is a pipe and hard-wraps everything it renders — mid-sentence
    // in a refusal, mid-cell in a table. Every caller that reads this
    // output is parsing it, so the wide console is the default rather than
    // something each one has to remember (three call sites already passed
    // their own COLUMNS, at two different widths). Still overridable
    // through `opts.env`.
    COLUMNS: WIDE_CONSOLE_COLUMNS,
    ...opts.env,
  };
  // An `undefined` from `opts.env` means REMOVE, not "leave as inherited":
  // deleted here rather than relied on inside `spawn`, so the contract is the
  // one this file states.
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return new Promise<HermesCliResult>((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: HOME_DIR,
      env: env as NodeJS.ProcessEnv,
    });

    let out = "";
    let err = "";
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("hermes call cancelled"));
      });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // stdout/stderr are always piped (see stdio above), so the streams are
    // present; stdin is only piped when `input` is passed.
    child.stdout!.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        finish(() => { child.kill("SIGKILL"); reject(new Error("hermes output exceeded the size limit")); });
        return;
      }
      out += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_OUTPUT_BYTES) {
        finish(() => { child.kill("SIGKILL"); reject(new Error("hermes error output exceeded the size limit")); });
        return;
      }
      err += chunk.toString();
    });

    const timer = setTimeout(() => {
      finish(() => { child.kill("SIGKILL"); reject(new Error("hermes timed out")); });
    }, timeoutMs);

    child.on("error", (e) => {
      finish(() => {
        // Same rule as the chat route's own spawn: ENOENT was rewritten to keep
        // the binary path off a customer's screen, and every other errno went
        // out raw. That matters MORE here — eleven setup-api routes reject-path
        // this straight into their JSON `error` — so the sanitising belongs at
        // the spawn, not at each caller.
        console.error("[hermes cli] spawn failed", e);
        reject(new Error(spawnFailureMessage(e)));
      });
    });
    child.on("close", (code) => {
      finish(() => resolve({ code, stdout: out.trim(), stderr: err.trim() }));
    });

    if (opts.input !== undefined && child.stdin) {
      // A child that exits before it has drained stdin makes the write fail on
      // the pipe. A stream error with no listener is not caught by the promise
      // — it surfaces at the process level and takes the whole web server down
      // — so route it through `finish` like every other failure path.
      //
      // Deferred by one turn on purpose. Not every child reads its input (a
      // `skill uninstall` that has nothing to confirm just exits), and there
      // the write failing says nothing about whether the command worked. Giving
      // an already-queued `close` the chance to settle first keeps those calls
      // reporting the child's real result; `finish` makes whichever lands first
      // the only one that counts.
      child.stdin.on("error", (e) => {
        setImmediate(() => finish(() => reject(e)));
      });
      child.stdin.end(opts.input);
    }
  });
}
