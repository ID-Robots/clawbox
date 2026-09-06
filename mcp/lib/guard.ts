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
import { realpathSync, statSync } from "fs";
import { basename, dirname, join, resolve, isAbsolute, normalize } from "path";
import { isProtectedFilePath } from "../../src/lib/file-guard";
// TASK-605's protected-path rule, from the module the OpenClaw hook plugin
// carries into ~/.openclaw/extensions. It lives there because a plugin copied
// out of the checkout has to take its rule with it; it is imported HERE
// because ClawBox's own `bash`, `write_file`, `edit_file` and `notebook_edit`
// reach the same files the harness's tools do, and a deny the agent can walk
// around through this server is not a deny. Its whole import graph is node
// builtins, so it satisfies the rule at the top of this file.
import {
  commandDenyReason,
  destructiveToken,
  isProtectedDirectory,
  pathDenyReason,
} from "../../scripts/openclaw-plugins/clawbox-path-guard/path-guard.mjs";
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

/**
 * The same check for a path a tool is about to WRITE, plus TASK-605's deny.
 *
 * Separate from `assertPathAllowed` because the two rules answer different
 * questions and the difference is the ruling's: the ClawBox tree and the
 * local-model folders may be read and listed — `data/llamacpp` and `data/embed`
 * are public subtrees of the data directory precisely so the desktop can show
 * what was downloaded — and may not be deleted, overwritten, truncated or
 * moved. A single allow-list would have had to choose one answer for both.
 *
 * The message names the rule rather than hiding it: unlike the credential
 * denial above, there is nothing secret about where this device keeps its own
 * code, and an agent told WHY it was refused can tell the owner instead of
 * trying the path again by another spelling.
 */
export function assertWritePathAllowed(abs: string): void {
  assertPathAllowed(abs);
  // THE REALPATH'D PARENT AS WELL AS THE PATH AS TYPED. `resolveUserPath`
  // normalises `..` and `~` but does not follow links, so a symlink the agent
  // planted earlier — `~/notes/models -> ~/clawbox/data/llamacpp/models` — would
  // reach this as a path with no protected root in it. Only the parent is
  // resolved, never the leaf: the file being written may not exist yet, and a
  // dangling name is not a reason to refuse. Same two-stage shape as
  // `coding-agent-media.ts`, and a resolve that fails is not evidence of
  // anything, so the typed path's verdict stands.
  let resolvedParent: string | null = null;
  try {
    resolvedParent = realpathSync(dirname(abs));
  } catch {
    resolvedParent = null;
  }
  if (resolvedParent) {
    const viaLink = pathDenyReason(join(resolvedParent, basename(abs)), HOME);
    if (viaLink) throw protectedWriteError();
  }
  // The PATH predicate, not the tool-shaped one: `toolCallDenyReason` drops any
  // string containing a newline, because a tool PARAMETER may be a file body —
  // and a filename may legally contain one, so routing a resolved path through
  // it let `…/models/a\nb.gguf` through.
  if (pathDenyReason(abs, HOME)) throw protectedWriteError();
}

function protectedWriteError(): ToolError {
  return new ToolError(
    "BLOCKED_PATH",
    "The ClawBox install tree and the local-model folders are protected on this device: they can be read, but not written, deleted or moved.",
    "Do not retry it by another path. Tell the user what you were asked to do and that the device refused it.",
  );
}

/**
 * Whether a shell string names a protected path in a destroying spelling.
 * Re-exported so `bash`'s pre-flight and the OpenClaw hook cannot disagree.
 */
export function commandDeniedByPathGuard(command: string, cwd?: string): string | null {
  // The SAME home this module expands `~` against, never os.homedir(): the
  // rule folds the resolved home into `~/` before matching, and a guard that
  // folded a different directory than `resolveUserPath` expands would answer
  // about a path nobody named.
  const inCommand = commandDenyReason(command, HOME);
  if (inCommand) return inCommand;
  // THE WORKING DIRECTORY, which `bash` takes and used to throw away. The whole
  // reason the OpenClaw hook reads `workdir` is that `cd <protected> && rm x`
  // reaches a text matcher as two tokens it cannot relate — and this tool is
  // handed the directory as an argument, so the same hole was open here in a
  // simpler form: `bash({ cwd: "~/clawbox/data/llamacpp/models", command: "rm
  // -f gemma.gguf" })`.
  if (!cwd || !isProtectedDirectory(cwd, HOME)) return null;
  const token = destructiveToken(command, HOME);
  return token ? `\`${token}\` run from inside ${cwd}` : null;
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
  /**
   * Run the child HERE. Omit it and the child runs in the project root, or in
   * `/` when that root cannot be entered — so an argument that is not an
   * absolute path does not name a fixed file. A directory named here is used
   * exactly as given and is never substituted.
   */
  cwd?: string;
  input?: string;
  /** Extra environment for this child only (e.g. DISPLAY for a screen grab). */
  extraEnv?: Record<string, string>;
}

/**
 * Where a child runs when the caller named no directory.
 *
 * `DEFAULT_CWD` is the project root, and it is the right answer for RESOLVING
 * a relative path (see resolveUserPath). It is NOT a precondition of running a
 * program: when that directory cannot be entered, `spawn` fails before the
 * binary is ever reached and `spawnArgv` settles at 127 — which `hasBinary()`
 * reads as "not installed" and `probeJournal()` as "no journal". The whole
 * capability sweep then answers false at once and the MCP server drops
 * disk_usage, disk_cleanup, logs_tail and screen_capture from its tool list
 * with nothing said (TASK-722, the false-failure class). On a box the tree is
 * normally there; this bites exactly when it briefly is not — mid-update, a
 * failed mount, a mis-set CLAWBOX_ROOT — which is when those tools are wanted.
 *
 * `/` is the fallback because it is the one directory that cannot be missing
 * and cannot be a surprise. It is safe only because every argument these tools
 * pass is already an ABSOLUTE path — the rule is restated on `spawnArgv` and on
 * `SpawnOptions.cwd`, where a caller adding an argument will read it.
 *
 * Asked per spawn rather than once at import: the tree comes BACK after an
 * update, and a capability answered once and kept for the process lifetime is
 * the probe-once class this codebase keeps producing.
 */
const FALLBACK_CWD = "/";

/**
 * The directory a `spawnArgv` call with no `cwd` will actually use.
 *
 * Exported because `check-tools.ts` PRINTS it when a probe answers false: a
 * note that named `DEFAULT_CWD` there would attach the old, wrong cause ("your
 * tree is missing") to a probe that failed for a real reason ("scrot is not
 * installed") — the very misdiagnosis this fix removes.
 */
export function defaultSpawnCwd(): string {
  try {
    return statSync(DEFAULT_CWD).isDirectory() ? DEFAULT_CWD : FALLBACK_CWD;
  } catch {
    return FALLBACK_CWD;
  }
}

/** The spawn failed on the DIRECTORY, before the program was reached. */
function isCwdRefusal(code: string | undefined): boolean {
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

interface Attempt {
  result: SpawnResult;
  /** Set when the child never started and the reason could be the directory. */
  refusedCode?: string;
}

/**
 * The ONLY process entry point outside the `bash` tool. Argv array, never a
 * shell string — so no argument, however hostile, can be re-parsed as a
 * command. Output is capped and the child is killed at the cap so a runaway
 * producer cannot OOM the stdio server and take every tool down with it.
 *
 * EVERY PATH IN `args` MUST BE ABSOLUTE. With no `cwd` the child runs in the
 * project root, or in `/` when that root cannot be entered, so a relative
 * argument does not name a fixed file. `resolveUserPath` is what every caller
 * uses to satisfy this, and `rm -rf --` is one of the callers.
 */
export function spawnArgv(
  bin: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const { cwd } = options;
  // A cwd the CALLER named is honoured exactly as given, missing or not: that
  // directory is the caller's meaning, and running somewhere else instead
  // would be the false-success mirror of the bug the fallback above fixes.
  if (cwd !== undefined) return spawnAttempt(bin, args, options, cwd).then((a) => a.result);
  const chosen = defaultSpawnCwd();
  return spawnAttempt(bin, args, options, chosen).then((a) => {
    // The stat above answers "does this exist", which is not the same question
    // as "can this process chdir into it" — a root-owned tree part-way through
    // an install answers yes and then refuses EACCES — and the two syscalls are
    // far enough apart for the tree to vanish between them, which is precisely
    // the mid-update window this fix is about. So the refusal itself, not a
    // prediction of it, is what selects the fallback.
    if (chosen === FALLBACK_CWD || !isCwdRefusal(a.refusedCode)) return a.result;
    return spawnAttempt(bin, args, options, FALLBACK_CWD).then((retry) => retry.result);
  });
}

function spawnAttempt(
  bin: string,
  args: string[],
  options: SpawnOptions,
  effectiveCwd: string,
): Promise<Attempt> {
  const { timeoutMs = 15_000, maxBytes = 4 * 1024 * 1024, input, extraEnv } = options;
  return new Promise((resolveA) => {
    const resolveP = (result: SpawnResult, refusedCode?: string) => resolveA({ result, refusedCode });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: effectiveCwd, env: { ...process.env, HOME, ...extraEnv }, shell: false });
    } catch (err) {
      resolveP({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 127,
        timedOut: false,
        truncated: false,
      }, (err as NodeJS.ErrnoException | undefined)?.code);
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    let refusedCode: string | undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      // Release pipes a surviving grandchild may still hold, so this process
      // does not accumulate open handles once per hung call.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveP({ stdout, stderr, exitCode, timedOut, truncated }, refusedCode);
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
      // The code travels with the result so the caller above can tell "the
      // directory refused us" from "the program is not there" — the same
      // message text serves both.
      refusedCode = (err as NodeJS.ErrnoException).code;
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

/**
 * Keep as many rows as fit `budget` characters, and say how many did not.
 *
 * "As many as fit", not "the longest prefix that fits": a row too big for the
 * budget left is SKIPPED and the shorter rows behind it are still considered.
 * Returning at the first overflow spent the rest of the tier on one outlier —
 * with a single store skill carrying a 2 000-character card name (the
 * frontmatter ceiling), skill_list listed 61 built-ins and dropped 41 store
 * skills that would have fitted, the exact inversion its tiers exist to
 * prevent. Rows are in priority order, so skipping one costs only itself.
 *
 * The alternative is capText() below, which is the LAST line of defence: it
 * hard-slices the finished string, so a list that outgrows its cap stops
 * mid-row — unparseable JSON for a tool that answers JSON, a half-written id
 * for one that answers lines — and appends "narrow the query", which the two
 * list tools cannot do because neither takes an argument. A list tool that
 * knows its own budget can drop WHOLE rows and say how many, which is a
 * partial answer instead of a broken one.
 *
 * `cost` is what a row spends, INCLUDING whatever the caller's format puts
 * around it: one newline for a list of lines (the default), and for a JSON
 * array the escaped string plus the indent and the comma. Passing the row's
 * bare length there is the mistake this parameter exists to prevent — a `"` or
 * a `\\` in a third party's text costs an extra character each, a control
 * character up to five, and an underestimate hands the slicer a string that is
 * over the cap after all. A caller whose exact size it cannot predict should
 * measure the finished string and shrink, using this only as the seed.
 */
export function fitRows(
  rows: readonly string[],
  budget: number,
  cost: (row: string) => number = (row) => row.length + 1,
): { kept: string[]; keptIndexes: number[]; omitted: number } {
  const kept: string[] = [];
  // The caller usually has an OBJECT behind each row and needs to know which
  // ones survived; with a prefix it could slice, and with a skip it cannot.
  const keptIndexes: number[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const spend = cost(rows[i]);
    if (used + spend > budget) continue;
    used += spend;
    kept.push(rows[i]);
    keptIndexes.push(i);
  }
  return { kept, keptIndexes, omitted: rows.length - kept.length };
}

/** Cap a string at the tool boundary and say what to do about the truncation. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated, ${omitted} chars omitted — narrow the query]`;
}
