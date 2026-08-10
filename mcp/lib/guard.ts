// Path and process safety for every file-touching tool.
//
// IMPORT RULE for mcp/lib/**: a src/lib module may be imported here only if its
// ENTIRE transitive import graph is relative paths + node builtins. Verified
// safe today: edition-source, file-guard (→ config-store), hermes-skills,
// hermes-reasoning. Anything using the "@/" alias is forbidden — bun resolves
// it inconsistently for files outside the root tsconfig include, and it drags
// server-only Next.js code into this stdio process.
//
// The secret denylist is src/lib/file-guard.ts and nothing else. The MCP used
// to carry its own parallel copy (SECRET_PATH_RES), which had drifted: it never
// knew about ~/.hermes, so `grep -r . ~/.hermes` printed every provider key and
// the ClawBox AI billing token. One list, symlink-resolving, shared with the
// Files API.

import { spawn } from "child_process";
import { join, resolve, isAbsolute, normalize } from "path";
import { isProtectedFilePath } from "../../src/lib/file-guard";
import { ToolError } from "./errors";

export const HOME = process.env.HOME || "/home/clawbox";
export const DEFAULT_CWD = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";

// Device nodes and process memory. This is a DIFFERENT concern from the secret
// denylist (these are not credentials, they are files that hang or OOM a
// reader), so it lives here rather than being pushed into file-guard.
const BLOCKED_EXACT = new Set([
  "/dev/zero", "/dev/null", "/dev/random", "/dev/urandom",
  "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/console",
]);

function isDevicePath(abs: string): boolean {
  if (BLOCKED_EXACT.has(abs)) return true;
  if (abs === "/dev" || abs.startsWith("/dev/")) return true;
  // /proc/<pid>/environ carries every secret the process was started with.
  if (abs === "/proc" || abs.startsWith("/proc/")) return true;
  if (abs.startsWith("/sys/")) return true;
  return false;
}

/**
 * Expand `~`, resolve relative paths against the project root, and reject
 * anything that cannot be a real path. Returns an absolute, normalised path.
 */
export function resolveUserPath(input: string): string {
  if (input.includes("\0")) {
    throw new ToolError(
      "BAD_ARGUMENT",
      "That path contains an illegal character.",
      "Pass a plain filesystem path with no control characters.",
    );
  }
  let p = input.trim();
  if (!p) {
    throw new ToolError("BAD_ARGUMENT", "The path was empty.", "Pass a file or directory path.");
  }
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
  return normalize(isAbsolute(p) ? p : resolve(DEFAULT_CWD, p));
}

/** True when this path may be read, listed, searched or written by a tool. */
export function isAllowedPath(abs: string): boolean {
  if (isDevicePath(abs)) return false;
  return !isProtectedFilePath(abs);
}

/**
 * Throw a BLOCKED_PATH the agent can act on. The message deliberately names no
 * path and no reason detail: this tool is reachable from untrusted page content,
 * and "blocked because it is ~/.hermes/.env" is itself a map of where the
 * secrets live.
 */
export function assertPathAllowed(abs: string): void {
  if (isAllowedPath(abs)) return;
  throw new ToolError(
    "BLOCKED_PATH",
    "That path holds device credentials or a device node and is not accessible to tools.",
    "Do not try variations of it. Tell the user the file is protected and continue with the rest of the task.",
  );
}

/** Drop every protected path from a result list (entries, glob hits, matches). */
export function filterAllowedPaths(paths: string[]): string[] {
  return paths.filter((p) => isAllowedPath(p));
}

// ── Process execution ────────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface SpawnOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  input?: string;
  /** Extra environment for this child only (e.g. DISPLAY for a screen grab). */
  extraEnv?: Record<string, string>;
}

/**
 * The ONLY process entry point outside the `bash` tool. Argv array, never a
 * shell string — so no argument, however hostile, can be re-parsed as a
 * command. Output is capped and the child is killed at the cap so a runaway
 * producer cannot OOM the stdio server and take every tool down with it.
 */
export function spawnArgv(
  bin: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const { timeoutMs = 15_000, maxBytes = 4 * 1024 * 1024, cwd = DEFAULT_CWD, input, extraEnv } = options;
  return new Promise((resolveP) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd, env: { ...process.env, HOME, ...extraEnv }, shell: false });
    } catch (err) {
      resolveP({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 127,
        timedOut: false,
        truncated: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);

    const onChunk = (which: "out" | "err") => (d: Buffer) => {
      if (stdout.length + stderr.length >= maxBytes) return;
      const text = d.toString();
      if (which === "out") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length >= maxBytes) {
        truncated = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };

    child.stdout?.on("data", onChunk("out"));
    child.stderr?.on("data", onChunk("err"));

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ stdout, stderr, exitCode, timedOut, truncated });
    };
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (err: Error) => {
      stderr += err.message;
      finish(127);
    });

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* child exited before reading stdin */ });
      child.stdin.end(input);
    }
  });
}

/** Does this binary exist on PATH? Used for startup capability probes. */
export async function hasBinary(bin: string): Promise<boolean> {
  const r = await spawnArgv("/usr/bin/env", ["which", bin], { timeoutMs: 3_000 });
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

/** Cap a string at the tool boundary and say what to do about the truncation. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated, ${omitted} chars omitted — narrow the query]`;
}
