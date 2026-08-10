import { spawn } from "child_process";
import path from "path";
import { HERMES_BIN } from "@/lib/harness";

// Shared helper to run a `hermes` CLI subcommand from a setup-api route.
//
// Every arg is passed as an argv element (spawn with an array, NO shell), so
// route inputs can never inject a command. Callers are still responsible for
// validating any value that could be misread as a FLAG (a value starting with
// "-") — pass those through a strict allowlist/charset first.

const HOME_DIR = process.env.HOME || "/home/clawbox";
const DEFAULT_TIMEOUT_MS = 30_000;
// A config/auth command's output is tiny; cap the buffer so a misbehaving
// child can't grow it unbounded.
const MAX_OUTPUT_BYTES = 1_000_000;

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
     */
    signal?: AbortSignal;
  } = {},
): Promise<HermesCliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<HermesCliResult>((resolve, reject) => {
    const child = spawn(HERMES_BIN, args, {
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
      finish(() => resolve({ code, stdout: out.trim(), stderr: err.trim() }));
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}
