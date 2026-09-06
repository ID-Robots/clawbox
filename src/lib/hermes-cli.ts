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
// One name each, because the silenced version probe below has to tell "the
// child could not be started" (retry the supported call) from "the child said
// far too much" (asking again would overflow the same buffer).
const OUTPUT_LIMIT_MESSAGE = "hermes output exceeded the size limit";
const ERROR_OUTPUT_LIMIT_MESSAGE = "hermes error output exceeded the size limit";
const isOutputLimitError = (e: unknown) =>
  e instanceof Error && (e.message === OUTPUT_LIMIT_MESSAGE || e.message === ERROR_OUTPUT_LIMIT_MESSAGE);

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
//
// The shim is four lines: unset PYTHONPATH, unset PYTHONHOME, exec
// `<agent_dir>/venv/bin/python <agent_dir>/hermes`. Where that agent dir is
// resolves the way the rest of this repo resolves it — `hermesHome()` in
// hermes-env.ts, `whatsappBridgeInstallDir()` in hermes-whatsapp.ts — so both
// documented overrides move BOTH halves of the probe together and the silent
// form can never answer for a different install than the fallback runs. Read
// per call rather than at import, and copied rather than imported: this block
// is meant to be deleted whole, and a new module edge out of hermes-cli.ts
// would have to be added to every suite that mocks that module.
const hermesAgentDir = () =>
  process.env.HERMES_AGENT_DIR ||
  path.join(process.env.HERMES_HOME || path.join(HOME_DIR, ".hermes"), "hermes-agent");
const SILENT_VERSION_PY =
  "from hermes_cli._startup_fast import print_fast_version_info as v; v(check_updates=False)";
/** The one argv this file knows a silent equivalent for. */
const isSilenceableVersionCall = (args: string[]) => args.length === 1 && args[0] === "--version";
/**
 * The silent attempt's own ceiling, spent ON TOP of the caller's budget.
 *
 * Deliberately not a slice of `timeoutMs`: the supported call has to keep
 * every millisecond it had before this workaround existed, or a cold, loaded
 * Orin where `hermes --version` answers in eight seconds would start reporting
 * no version at all — the workaround causing the very failure it removes. The
 * silent form does no network and measured 853-870 ms on a Hermes box; 5 s is
 * headroom for a cold interpreter start, and it is time added at most once.
 */
const SILENT_VERSION_TIMEOUT_MS = 5_000;
/**
 * A banner ClawBox can actually use.
 *
 * `parseHermesVersion` falls back to SHOWING an unrecognised first line, so
 * anything the interpreter happens to print (a sitecustomize notice, a future
 * upstream banner) would become "the Hermes version" on the About screen and
 * the supported call that prints the real one would never be made.
 */
const looksLikeVersionBanner = (stdout: string) =>
  /\bv?\d+\.\d+/.test(stdout.split("\n", 1)[0] ?? "");

export interface HermesCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HermesCliOptions {
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string>;
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
    const agentDir = hermesAgentDir();
    try {
      const quiet = await spawnHermes(
        path.join(agentDir, "venv", "bin", "python"),
        ["-c", SILENT_VERSION_PY],
        {
          ...opts,
          timeoutMs: Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, SILENT_VERSION_TIMEOUT_MS),
          // The package IS the checkout — there is no pip dist to import — so
          // the checkout goes on the path the shim's `exec <dir>/hermes` puts
          // there. PYTHONSAFEPATH keeps the CWD off sys.path[0], where `-c`
          // would otherwise put it and the shim never does; Python 3.11+ reads
          // it and older interpreters ignore an unknown PYTHON* variable.
          env: { ...opts.env, PYTHONPATH: agentDir, PYTHONSAFEPATH: "1" },
        },
        // PYTHONHOME goes the way the shim takes it — removed, not set: an
        // inherited one aims this interpreter at a different stdlib. And no
        // console line for a speculative spawn that has a supported call
        // behind it, or a box with no venv logs every probe twice.
        { unsetEnv: ["PYTHONHOME"], logSpawnFailure: false },
      );
      if (quiet.code === 0 && looksLikeVersionBanner(quiet.stdout)) return quiet;
    } catch (e) {
      // Fall through to the supported call — except for the one failure that
      // says the CHILD misbehaved rather than that it could not be started:
      // asking the same question again would overflow the same buffer.
      if (isOutputLimitError(e)) throw e;
    }
  }

  return spawnHermes(bin, argv, opts);
}

interface SpawnExtras {
  /** Variables to REMOVE from the child's environment — the shim's `unset`. */
  unsetEnv?: readonly string[];
  /**
   * Whether a child that could not be started is worth a console line. Off for
   * a speculative attempt that has a supported call behind it.
   */
  logSpawnFailure?: boolean;
}

function spawnHermes(
  bin: string,
  argv: string[],
  opts: HermesCliOptions,
  extras: SpawnExtras = {},
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
  const env: NodeJS.ProcessEnv = {
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
  // Removals are applied AFTER the defaults, so HOME/PATH/COLUMNS stay the
  // guarantee this function makes and only this file can take one away.
  for (const key of extras.unsetEnv ?? []) delete env[key];
  return new Promise<HermesCliResult>((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: HOME_DIR,
      env,
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
        finish(() => { child.kill("SIGKILL"); reject(new Error(OUTPUT_LIMIT_MESSAGE)); });
        return;
      }
      out += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_OUTPUT_BYTES) {
        finish(() => { child.kill("SIGKILL"); reject(new Error(ERROR_OUTPUT_LIMIT_MESSAGE)); });
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
        if (extras.logSpawnFailure !== false) console.error("[hermes cli] spawn failed", e);
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
