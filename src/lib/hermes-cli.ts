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

export interface HermesCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runHermesCli(
  args: string[],
  opts: {
    timeoutMs?: number;
    input?: string;
    env?: Record<string, string>;
    /**
     * Kill the child when the caller gives up (a browser that navigated away
     * aborts its fetch, but that alone would leave the process running to its
     * timeout). Optional — callers that don't pass one behave exactly as before.
     *
     * A route may hand this its `request.signal` for a probe, or for the FIRST
     * durable write of the request — cancelling either leaves the box exactly
     * as it was. It must NOT hand it to work that follows a durable write: a
     * browser that locked its screen would then leave the token in ClawBox's
     * store and not in Hermes', or a saved channel with a gateway nobody
     * started. Past the first write, finish the job.
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
  } = {},
): Promise<HermesCliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = opts.sudo ? SUDO_BIN : HERMES_BIN;
  const argv = opts.sudo ? ["-n", HERMES_BIN, ...args] : args;
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
  return new Promise<HermesCliResult>((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: HOME_DIR,
      env: {
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
      },
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
