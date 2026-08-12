import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { HERMES_BIN } from "@/lib/harness";

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

export interface HermesCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// ── Serialise config writes with the shell writers ──────────────────────────
// ~/.hermes/config.yaml has several writers, and each does a read-modify-write:
// scripts/setup-hermes-dashboard-auth.sh, scripts/register-mcp.sh, and the
// Hermes CLI itself — which is what `hermes config set` runs here. A writer that
// snapshotted the file before another wrote, and saves after, silently erases
// the other's block. That is how the dashboard auth block disappeared between
// being written and being verified; a Settings save landing on the same window
// can drop it the same way.
//
// The two shell writers take an flock over `<config>.lock`
// (scripts/lib/hermes-config-lock.sh). This is the third participant: run the
// mutating CLI call under the SAME lock, via flock(1) so there is no new
// dependency and no second lock implementation. Read-only calls (`config get`,
// `models list`) are deliberately NOT wrapped — they cannot lose an update, and
// serialising them behind a provisioning run would stall the UI for no gain.
const FLOCK_BIN = "/usr/bin/flock";
// Fail the request rather than hang it. A UI action must not block for the
// 120s the provisioning scripts are willing to wait.
const CONFIG_LOCK_WAIT_S = 30;
// flock's own exit status when the lock could not be acquired. Chosen (rather
// than the default 1) so "the device was busy" is distinguishable from "the
// hermes command itself failed" — two different outcomes deserve two messages.
export const HERMES_CONFIG_LOCK_BUSY = 75;

let flockPresent: boolean | undefined;
function hasFlock(): boolean {
  if (flockPresent === undefined) {
    try {
      flockPresent = fs.existsSync(FLOCK_BIN);
    } catch {
      flockPresent = false;
    }
  }
  return flockPresent;
}

/** The same lock file the shell writers derive, resolved the same way. */
function hermesConfigLockPath(): string {
  const dir = path.join(HOME_DIR, ".hermes");
  let resolved = dir;
  try {
    // Match scripts/lib/hermes-config-lock.sh, which canonicalises the config's
    // directory before appending ".lock" — two spellings of the same directory
    // must not produce two different lock files.
    resolved = fs.realpathSync(dir);
  } catch {
    // Not created yet (fresh flash). The raw path is what the scripts fall back
    // to as well.
  }
  return path.join(resolved, "config.yaml.lock");
}

/** Only the subcommands that rewrite the config file need the lock. */
function mutatesConfig(args: string[]): boolean {
  return args[0] === "config" && (args[1] === "set" || args[1] === "unset");
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
  let bin = opts.sudo ? SUDO_BIN : HERMES_BIN;
  let argv = opts.sudo ? ["-n", HERMES_BIN, ...args] : args;
  // A config write goes through the shared lock so it cannot interleave with the
  // provisioning scripts' read-modify-write. `sudo` calls are excluded: the only
  // one is `gateway install --system`, which writes a systemd unit, not this
  // config.
  const serialised = !opts.sudo && mutatesConfig(args) && hasFlock();
  if (serialised) {
    argv = [
      "-w",
      String(CONFIG_LOCK_WAIT_S),
      "-E",
      String(HERMES_CONFIG_LOCK_BUSY),
      hermesConfigLockPath(),
      bin,
      ...argv,
    ];
    bin = FLOCK_BIN;
  }
  return new Promise<HermesCliResult>((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: HOME_DIR,
      env: {
        ...process.env,
        HOME: HOME_DIR,
        PATH: `${path.dirname(HERMES_BIN)}:${process.env.PATH || ""}`,
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
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("Hermes is not installed on this device"));
          return;
        }
        reject(e);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        // flock reports the lock conflict itself and never ran hermes, so there
        // is no child output to explain the failure. Say which of the two it
        // was — "the device was busy" and "the command failed" send the caller
        // to different places.
        if (serialised && code === HERMES_CONFIG_LOCK_BUSY) {
          resolve({
            code,
            stdout: "",
            stderr:
              "The device is busy writing its configuration (provisioning or a restart is in progress). Nothing was changed — try again in a moment.",
          });
          return;
        }
        resolve({ code, stdout: out.trim(), stderr: err.trim() });
      });
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
