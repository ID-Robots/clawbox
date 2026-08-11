// Path and process safety for every file-touching tool.
//
// IMPORT RULE for mcp/lib/**: a src/lib module may be imported here only if its
// ENTIRE transitive import graph is relative paths + node builtins. Verified
// safe today: edition-source, file-guard (→ config-store), hermes-skills,
// hermes-reasoning. Anything using the "@/" alias is forbidden — bun resolves
// it inconsistently for files outside the root tsconfig include, and it drags
// server-only Next.js code into this stdio process.
//
// The secret denylist is src/lib/file-guard.ts PLUS the two MCP-local rules
// below — ONE list, not two. The MCP previously kept a parallel copy of the
// rules, which is a shape that drifts: two lists of the same thing eventually
// disagree, and the weaker one wins wherever it is consulted. What stays here is
// only what file-guard cannot express, because file-guard is shared with the
// Files API, where the user drives the file manager themselves and the trust
// decision is a different one.

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

// Dotenv files, anywhere — read AND write.
//
// <CLAWBOX_ROOT>/.env is a credential store (see .env.example for what the
// install keeps there), and it is also configuration: clawbox-setup.service
// loads it as an EnvironmentFile, so its contents shape how the web server comes
// up on the next restart (src/lib/edition-source.ts explains why the edition
// lock deliberately sits in a root-owned file instead). Neither role belongs to
// an agent-facing tool, so the whole family is out of reach here.
//
// This rule is MCP-local rather than in file-guard because file-guard also backs
// the Files app, where a user browsing their own project folder is a different
// trust decision from a tool acting on content the device did not author.
// The backslash alternative is only for the dev machines this file is unit-run
// on; the device is POSIX.
const DOTENV_RE = /(^|[/\\])(\.env(\.[^/\\]*)?|\.envrc)$/;

function isDotenvPath(abs: string): boolean {
  return DOTENV_RE.test(abs);
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
  if (isDotenvPath(abs)) return false;
  return !isProtectedFilePath(abs);
}

/**
 * Basenames that mean "a credential store" wherever they appear in a string.
 * Used by the `bash` pre-flight, which sees a shell string rather than a path.
 */
export const SECRET_NAME_RE =
  /(^|[^\w.-])\.(ssh|hermes|openclaw|clawkeep|codex|gnupg|aws|kube|env|envrc|netrc|npmrc|pypirc|pgpass|git-credentials|session-secret|mcp-token|local-ai-token|hermes-dashboard-pw)(?![\w-])|(^|[^\w-])id_(rsa|ecdsa|ed25519)(?![\w-])/i;

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

/** How long to keep collecting output after the child has already exited. */
const DRAIN_MS = 250;

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
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      // Release pipes a surviving grandchild may still hold, so this process
      // does not accumulate open handles once per hung call.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveP({ stdout, stderr, exitCode, timedOut, truncated });
    };

    // Kill, then settle on OUR schedule. Killing the direct child does not
    // necessarily close the pipes — a grandchild can hold them open — so waiting
    // for an event after the kill is waiting for something that may never come.
    const hardStop = (exitCode: number) => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      setTimeout(() => finish(exitCode), DRAIN_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      hardStop(124);
    }, timeoutMs);

    const onChunk = (which: "out" | "err") => (d: Buffer) => {
      if (stdout.length + stderr.length >= maxBytes) return;
      const text = d.toString();
      if (which === "out") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length >= maxBytes) {
        truncated = true;
        hardStop(1);
      }
    };

    child.stdout?.on("data", onChunk("out"));
    child.stderr?.on("data", onChunk("err"));

    child.on("close", (code) => finish(code ?? 1));
    // `close` waits for every stdio pipe to reach EOF. A child that backgrounds
    // a grandchild (`find … -exec … &`, anything daemonising) leaves the pipe
    // open forever, so `close` never fires. That hung the STARTUP PROBES in
    // lib/context.ts, which buildContext awaits before server.connect() — the
    // whole tool surface silently failed to appear. Settle from `exit` plus a
    // short drain window instead.
    child.on("exit", (code) => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => finish(code ?? 1), DRAIN_MS);
    });
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
