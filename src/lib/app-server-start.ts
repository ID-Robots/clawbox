/**
 * Starting a project's own server from its clawbox.json — the half of "put the
 * app on the desktop" the box used to leave to whoever was still around.
 *
 * `registerServerApp` (src/lib/app-proxy.ts) registers an app only while its
 * server is LISTENING, because the listener check is what stops a manifest
 * from pointing the proxy at some other service. But a coding run is told to
 * end what it started, and it does: it builds the app, serves it once to look
 * at it, stops the server and finishes. The settle then found nothing on the
 * port, said "Not on the desktop yet" in a run log nobody was reading, and the
 * owner who had asked for an app got no icon at all.
 *
 * So when a run settles with a manifest that names a `port` AND a `start`
 * command, and nothing is listening, the box runs that command itself — in
 * the project folder, as this user — waits for the project's own listener to
 * come up, and registers the app. The listener check is unchanged and still
 * decides: a `start` that brings up nothing, or something that is not the
 * project's, registers nothing.
 *
 * WHO MAY CAUSE A START. Only a run settling in that project. The command is
 * text the run itself wrote (or found in the repository it was asked to work
 * in), and a run already executes commands there as this user — starting the
 * server it describes hands it nothing new. The owner's "put on the desktop"
 * route and the legacy-stub migration do NOT start anything: they act on a
 * manifest nobody on this box has run yet.
 *
 * WHERE IT RUNS. In a transient systemd user scope of its own when the box
 * has a user manager (the same reason a coding run has one, see
 * coding-run-unit.ts: a plain child sits in the web server's cgroup and is
 * killed with it at the end of every in-app update), and as a detached child
 * otherwise.
 *
 * WHAT IT RUNS WITH. The run's PATH, behind the web server's own node when the
 * list does not name its folder, then every place node and bun live that the
 * run's fixed list does not name (`startSearchPath`). The run found
 * them through its shell's profile — nvm, a tarball node the web server's own
 * unit puts on its PATH — and `/bin/sh -c` has no profile: with the run's list
 * alone, `npm start` on such a box exited 127 before anything listened. When a
 * start does stop, what it printed is in the answer (`startOutputLine`), so
 * the run's feed says "bun: not found" rather than only an exit code.
 *
 * WHAT IT NEEDS FIRST. A project whose package.json declares dependencies and
 * that has no node_modules gets them installed before the start
 * (`installAppDependencies`): a Store package never carries node_modules
 * (the publisher leaves it out), and
 * `next build && next start` without them is the shell's exit 127. The same
 * install is what the Store's install calls before it registers a server app,
 * so Install again recovers an app installed before the box did this. An
 * install that fails starts nothing, and says which tool failed and what it
 * printed last.
 *
 * WHAT STOPS IT. `stopServerApp`: the uninstall, before the app's folder goes
 * (a server left running from a removed folder held the app's port, and the
 * next install of the same app found it taken), and an install again that
 * finds such a leftover on the port. Only a process proven to be the app's —
 * its scope, its folder — is ever stopped, never whatever holds the port.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path, { untraced } from "@/lib/runtime-path";
import { forgetListenerVerdict, listenerOwnedBy, portListeners, processCwd, registerServerApp, type RegisterOutcome } from "@/lib/app-proxy";
import { runChild } from "@/lib/child-run";
import { APP_ID_RE } from "@/lib/code-projects";
import { DATA_DIR } from "@/lib/config-store";
import { type ClawboxManifest, isProxyablePort } from "@/lib/clawbox-manifest";
import { findSystemdTool, probeSystemdRun, scopeEnv } from "@/lib/coding-run-unit";
import { isInside } from "@/lib/file-guard";
import { appMemoryLimits } from "@/lib/box-memory-policy";

/** Every unit this module is ever allowed to name. */
export const APP_UNIT_PREFIX = "clawbox-app-";

/**
 * What an app server yields under contention, against the default 100. A WEIGHT
 * is not a quota: a lone app on an idle box still gets every core, while one
 * that is compiling in a loop cannot starve the desktop the owner is looking
 * at. `IOWeight` only applies where the user manager delegates the `io`
 * controller; the nice level reaches the disk either way, because the kernel's
 * I/O schedulers derive best-effort priority from nice.
 */
export const APP_CPU_WEIGHT = 20;
export const APP_IO_WEIGHT = 20;
export const APP_NICE = 10;

/** How long a started server has to be found listening. A production build's server answers in seconds; a dev server on this board can take most of a minute. */
export const APP_START_WAIT_MS = 60_000;
const POLL_MS = 500;

/** Where a started server's output goes: one file per app, rewritten on each start. */
export function appServerLogPath(id: string): string {
  return untraced(path.join(DATA_DIR, "app-servers", `${id}.log`));
}

// A constant, not an inline literal: the same Turbopack tracing reason as
// child-run.ts's SCRIPT_RUNNER.
const START_SHELL: string = "/bin/sh";

/** The per-start stamp in an app's scope name. */
const SCOPE_STAMP_RE = /^[a-z0-9]{1,16}$/;
const SCOPE_SUFFIX = ".scope";

/**
 * The scope a box-started server of `id` runs in, read from its
 * /proc/<pid>/cgroup: `clawbox-app-<id>-<stamp>.scope` and nothing looser.
 * Exported for its test.
 *
 * Split at the LAST hyphen, because ids have hyphens of their own: the scope
 * of `audio-app` is never taken for one of `audio`. An owner's hand-written
 * `clawbox-app-<id>.service` is not a scope and is never matched — it is the
 * owner's, not the box's, to stop.
 */
export function appScopeOf(cgroup: string, id: string): string | null {
  if (!APP_ID_RE.test(id)) return null;
  for (const line of cgroup.split("\n")) {
    // hierarchy-ID:controllers:path — one line on cgroup v2, one per hierarchy on v1.
    const at = line.indexOf(":", line.indexOf(":") + 1);
    if (at < 0) continue;
    const unit = line.slice(line.lastIndexOf("/") + 1).trim();
    if (!unit.startsWith(APP_UNIT_PREFIX) || !unit.endsWith(SCOPE_SUFFIX)) continue;
    const name = unit.slice(APP_UNIT_PREFIX.length, -SCOPE_SUFFIX.length);
    const dash = name.lastIndexOf("-");
    if (dash > 0 && name.slice(0, dash) === id && SCOPE_STAMP_RE.test(name.slice(dash + 1))) return unit;
  }
  return null;
}

/**
 * `systemd-run`'s prefix in front of the start command. Pure and exported for
 * its test. The unit name is rebuilt from the validated id and a per-start
 * stamp: a scope systemd has not finished collecting would refuse a reused
 * name.
 */
export function buildAppScopeArgv(systemdRunPath: string, id: string, stamp: string, command: string): { bin: string; argv: string[] } | null {
  if (!APP_ID_RE.test(id) || !SCOPE_STAMP_RE.test(stamp)) return null;
  // The cap is a share of this box's RAM, not a literal: an 8 GB Orin Nano, a
  // 16 GB laptop and a 128 GB Spark run the same image, and a number written
  // for one is an OOM kill on another. See box-memory-policy.ts — measured on
  // this box before the cap existed: one app wrote 14 MB/s and peaked at
  // 3.7 GB with nothing to throttle it.
  const limits = appMemoryLimits();
  return {
    bin: systemdRunPath,
    argv: [
      "--user",
      "--scope",
      `--unit=${APP_UNIT_PREFIX}${id}-${stamp}`,
      "--collect",
      "--quiet",
      "-p",
      `MemoryHigh=${limits.high}`,
      "-p",
      `MemoryMax=${limits.max}`,
      "-p",
      `CPUWeight=${APP_CPU_WEIGHT}`,
      "-p",
      `IOWeight=${APP_IO_WEIGHT}`,
      `--nice=${APP_NICE}`,
      "--",
      START_SHELL,
      "-c",
      command,
    ],
  };
}

/** Where a JavaScript toolchain may be on this box, beyond the run's own PATH. */
export interface ToolchainPlaces {
  /** The user's home: `~/.bun`, `~/.nvm` and `~/.npm-global` are under it. */
  home: string;
  /** The runtime the web server itself runs on: a node that is certainly there, with npm beside it. */
  execPath: string;
  /** The web server's own PATH. The x64 installer's unit puts its tarball node on it. */
  envPath: string;
  /** `$BUN_INSTALL`, when bun was installed somewhere else. */
  bunInstall?: string | null;
  /** `$NVM_DIR`, when nvm lives somewhere else. */
  nvmDir?: string | null;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

/** Every node nvm installed, newest first: the one a fresh shell most likely has. */
function nvmNodeBins(nvmDir: string): string[] {
  const versions = path.join(nvmDir, "versions", "node");
  let names: string[];
  try {
    names = fs.readdirSync(versions);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, parts: VERSION_RE.exec(name)?.slice(1).map(Number) }))
    .filter((entry): entry is { name: string; parts: number[] } => Array.isArray(entry.parts))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2])
    .map((entry) => path.join(versions, entry.name, "bin"));
}

/**
 * The PATH a start command runs with. Exported for its test.
 *
 * The run's PATH keeps its own order, so a command it resolves resolves to
 * the same binary here — with one exception. The folder of the node the web
 * server runs on goes IN FRONT when the run's list does not name it: the x64
 * installer unpacks its own node precisely because the distro's is too old,
 * and leaves that one in /usr/bin or /usr/local/bin, where the run's list
 * would find it first (and npm's `#!/usr/bin/env node` with it). On the usual
 * box that folder is /usr/bin, already on the list, and nothing moves.
 *
 * What follows only fills the gaps, in the order a shell would most likely
 * have found them: bun, nvm, npm's global prefix, the FHS directories, and
 * the web server's own PATH last. Empty and relative entries are dropped,
 * because the command runs in the project folder and they would resolve
 * inside it.
 */
export function startSearchPath(searchPath: string, places: ToolchainPlaces): string {
  const run = searchPath.split(":");
  const ownNode = path.dirname(places.execPath);
  const candidates = [
    ...(run.includes(ownNode) ? [] : [ownNode]),
    ...run,
    places.bunInstall ? path.join(places.bunInstall, "bin") : "",
    path.join(places.home, ".bun", "bin"),
    ...nvmNodeBins(places.nvmDir || path.join(places.home, ".nvm")),
    path.join(places.home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...places.envPath.split(":"),
  ];
  const dirs: string[] = [];
  for (const dir of candidates) {
    if (dir && path.isAbsolute(dir) && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(":");
}

/**
 * The environment a project's own command runs with: this user, the PATH
 * `startSearchPath` builds, and nothing else of the web server's — its
 * NODE_ENV=production would make an install leave out the devDependencies a
 * `next build` needs.
 */
function appCommandEnv(searchPath: string, directory: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = process.env.HOME || directory;
  const user = process.env.USER || process.env.LOGNAME || path.basename(home);
  return scopeEnv({
    HOME: home,
    USER: user,
    LOGNAME: user,
    PATH: startSearchPath(searchPath, {
      home: os.homedir(),
      execPath: process.execPath,
      envPath: process.env.PATH ?? "",
      bunInstall: process.env.BUN_INSTALL,
      nvmDir: process.env.NVM_DIR,
    }),
    LANG: process.env.LANG || "C.UTF-8",
    ...extra,
  });
}

/** How long a dependency install may take. A cold install of `next` and its build tools on a Jetson is minutes. */
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;

export type DependencyTool = "bun" | "npm";

/** How a project's dependencies are installed. */
export interface DependencyInstallPlan {
  tool: DependencyTool;
  /** The binary, resolved on the PATH when it is there; its bare name otherwise (the spawn then says it is missing). */
  bin: string;
  args: string[];
  /** What runs instead when `args` stopped on a lockfile that does not match package.json. */
  fallback: string[] | null;
}

const BUN_LOCKFILES = ["bun.lock", "bun.lockb"];
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];
const NPM_QUIET = ["--no-audit", "--no-fund"];
/** bun's frozen install and `npm ci`, refusing a lockfile package.json has moved past. */
const LOCKFILE_MISMATCH_RE = /lockfile had changes|lockfile is frozen|package\.json and package-lock\.json[^\n]*in sync/i;

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** An executable called `name` in one of the PATH's folders, or null. */
function findOnPath(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not in this one.
    }
  }
  return null;
}

function packageManagerOf(directory: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf-8")) as { packageManager?: unknown };
    return typeof pkg?.packageManager === "string" ? pkg.packageManager.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Which tool installs a project's dependencies, and how. Exported for its test.
 *
 * bun when the project carries bun's lockfile or names bun as its
 * `packageManager`; npm when it carries npm's lockfile; otherwise bun when the
 * PATH has it, and npm when it does not. A lockfile is installed from as it
 * is (`--frozen-lockfile`, `npm ci`), with a plain install to fall back on
 * when package.json has moved past it.
 */
export function dependencyInstallPlan(directory: string, searchPath: string): DependencyInstallPlan {
  const has = (name: string) => isFile(path.join(directory, name));
  const bunLock = BUN_LOCKFILES.some(has);
  const npmLock = NPM_LOCKFILES.some(has);
  const bun = findOnPath("bun", searchPath);
  const tool: DependencyTool = bunLock || packageManagerOf(directory).startsWith("bun")
    ? "bun"
    : npmLock ? "npm" : bun ? "bun" : "npm";
  if (tool === "bun") {
    return { tool, bin: bun ?? "bun", args: bunLock ? ["install", "--frozen-lockfile"] : ["install"], fallback: bunLock ? ["install"] : null };
  }
  return {
    tool,
    bin: findOnPath("npm", searchPath) ?? "npm",
    args: npmLock ? ["ci", ...NPM_QUIET] : ["install", ...NPM_QUIET],
    fallback: npmLock ? ["install", ...NPM_QUIET] : null,
  };
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Written before an install starts and removed once it succeeds. */
function installPendingMarker(directory: string): string {
  return path.join(directory, ".clawbox", "deps-install-pending");
}

/**
 * A package.json that declares dependencies, and nothing at node_modules —
 * not even a link, which an install would write through. One that declares
 * none has nothing to install: npm would only write a package-lock.json into
 * the project and make no node_modules, so every start would install again.
 */
function needsDependencyInstall(directory: string): boolean {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const declared = DEPENDENCY_FIELDS.some((field) => {
    const deps = pkg?.[field];
    return !!deps && typeof deps === "object" && Object.keys(deps).length > 0;
  });
  if (!declared) return false;
  // An install the box began and never saw finish (the service stopped
  // mid-way) leaves a node_modules that is there but not whole.
  if (fs.existsSync(installPendingMarker(directory))) return true;
  try {
    fs.lstatSync(path.join(directory, "node_modules"));
    return false;
  } catch {
    return true;
  }
}

/** How many of an install's last lines the answer carries, and how long they may be together. */
const INSTALL_TAIL_LINES = 3;
const INSTALL_TAIL_MAX = 300;
/** npm's pointer to its own log file: a path, not a reason. */
const NPM_LOG_POINTER_RE = /complete log of this run/i;

/** The last lines an install printed, as one line. Exported for its test. */
export function installOutputTail(output: string): string | null {
  const lines = output
    .replace(ANSI_RE, "")
    .split(/\r?\n|\r/)
    .map((line) => line.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line && !NPM_LOG_POINTER_RE.test(line));
  if (lines.length === 0) return null;
  const tail = lines.slice(-INSTALL_TAIL_LINES).join(" · ");
  return tail.length > INSTALL_TAIL_MAX ? `…${tail.slice(-(INSTALL_TAIL_MAX - 1))}` : tail;
}

interface InstallRun {
  code: number | null;
  timedOut: boolean;
  /** The binary was not there to run. */
  missing: boolean;
  output: string;
}

/** How long, after an install exits, its output may take to arrive before the answer is given without the rest. */
const OUTPUT_DRAIN_MS = 1_000;

/** One install command, its output kept to its last few screens. Never rejects. */
function runInstall(bin: string, args: string[], directory: string, env: Record<string, string>, timeoutMs: number): Promise<InstallRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // Its own process group, so a timeout ends the scripts it ran too.
      child = spawn(/* turbopackIgnore: true */ bin, args, {
        cwd: directory,
        env: env as unknown as NodeJS.ProcessEnv,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, timedOut: false, missing: false, output: err instanceof Error ? err.message : String(err) });
      return;
    }
    let output = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === "number") void endProcessGroup(child.pid);
    }, timeoutMs);
    const finish = (run: Omit<InstallRun, "output" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, timedOut, output });
    };
    const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf-8")).slice(-OUTPUT_TAIL_BYTES); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.once("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      // The process never started: its error is the only reason there is.
      if (!missing && !output) output = err.message;
      finish({ code: null, missing });
    });
    // `close` waits for the output; a script that left a process holding the
    // pipe would keep it from ever coming, so `exit` answers shortly after.
    child.once("close", (code) => finish({ code, missing: false }));
    child.once("exit", (code) => { setTimeout(() => finish({ code, missing: false }), OUTPUT_DRAIN_MS).unref(); });
  });
}

function installFailure(plan: DependencyInstallPlan, args: string[], run: InstallRun, timeoutMs: number): string {
  const label = `${plan.tool} ${args[0]}`;
  if (run.missing) return `${label} failed: ${plan.tool} is not installed on this box.`;
  if (run.timedOut) {
    const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`;
    return `${label} failed: it did not finish within ${limit}.`;
  }
  const said = installOutputTail(run.output);
  if (said) return `${label} failed: ${said}`;
  return `${label} failed: it stopped${run.code === null ? "" : ` with exit code ${run.code}`} and printed nothing.`;
}

export type DependencyOutcome = { ok: true; installed: DependencyTool | null } | { ok: false; detail: string };

export interface InstallDependenciesInput {
  directory: string;
  /** The run's PATH, as for a start: `startSearchPath` adds where node and bun live beyond it. */
  searchPath: string;
  /** For the tests: a shorter limit. */
  timeoutMs?: number;
}

const installing = new Map<string, Promise<DependencyOutcome>>();

/**
 * Install a project's dependencies when it has a package.json and no
 * node_modules; nothing at all otherwise (`installed: null`). One install per
 * folder at a time: a second caller gets the first one's answer. Never throws.
 */
export function installAppDependencies(input: InstallDependenciesInput): Promise<DependencyOutcome> {
  const key = path.resolve(input.directory);
  const running = installing.get(key);
  if (running) return running;
  const attempt = installOnce({ ...input, directory: key })
    .catch((err): DependencyOutcome => ({ ok: false, detail: `Installing the app's dependencies failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }))
    .finally(() => { installing.delete(key); });
  installing.set(key, attempt);
  return attempt;
}

async function installOnce(input: InstallDependenciesInput): Promise<DependencyOutcome> {
  const { directory } = input;
  if (!needsDependencyInstall(directory)) return { ok: true, installed: null };
  const env = appCommandEnv(input.searchPath, directory);
  const plan = dependencyInstallPlan(directory, env.PATH);
  const timeoutMs = input.timeoutMs ?? DEPENDENCY_INSTALL_TIMEOUT_MS;
  const began = Date.now();
  const marker = installPendingMarker(directory);
  await fs.promises.mkdir(path.dirname(marker), { recursive: true });
  await fs.promises.writeFile(marker, `${began}\n`);
  let args = plan.args;
  let run = await runInstall(plan.bin, args, directory, env, timeoutMs);
  if (run.code !== 0 && !run.timedOut && !run.missing && plan.fallback && LOCKFILE_MISMATCH_RE.test(run.output)) {
    args = plan.fallback;
    run = await runInstall(plan.bin, args, directory, env, Math.max(timeoutMs - (Date.now() - began), 1_000));
  }
  if (run.code === 0 && !run.timedOut) {
    await fs.promises.rm(marker, { force: true });
    return { ok: true, installed: plan.tool };
  }
  // A half-made node_modules would read as installed next time, and the
  // retry would start straight into the same exit 127.
  await fs.promises.rm(path.join(directory, "node_modules"), { recursive: true, force: true }).catch(() => undefined);
  return { ok: false, detail: installFailure(plan, args, run, timeoutMs) };
}

/** How much of a failed start's log is read back: its last few screens. */
const OUTPUT_TAIL_BYTES = 16_384;
/** How long the line taken from it may be. The feed caps a whole step at 160 characters anyway. */
const OUTPUT_LINE_MAX = 200;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
/** The shell's own name in front of its complaint: dash's "/bin/sh: 1: ", bash's "bash: line 1: ". */
const SHELL_SAYS_RE = /^(?:\/(?:usr\/)?bin\/)?(?:sh|dash|bash):(?: line)? \d+: /;
/** A line that reads like the reason a start stopped. */
const TROUBLE_RE = /error|not found|cannot|can't|could not|couldn't|failed|denied|no such|missing|EADDRINUSE|EACCES|ENOENT/i;

/**
 * The one line of a failed start's output that says why. Exported for its test.
 *
 * The FIRST line that reads like an error, not the last: node prints its stack
 * and then its version banner after the error, and npm repeats the exit code
 * after the shell's "node: not found". An error line that only introduces the
 * next one ("error when starting preview server:") takes that line with it.
 * The last line when nothing reads like an error; null when there was no
 * output at all.
 */
export function startOutputLine(output: string): string | null {
  const lines = output
    .replace(ANSI_RE, "")
    .split(/\r?\n|\r/)
    .map((line) => line.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  let at = lines.findIndex((line) => TROUBLE_RE.test(line));
  if (at < 0) at = lines.length - 1;
  let said = lines[at].replace(SHELL_SAYS_RE, "");
  if (said.endsWith(":") && at + 1 < lines.length) said = `${said} ${lines[at + 1]}`;
  return said.length > OUTPUT_LINE_MAX ? `${said.slice(0, OUTPUT_LINE_MAX - 1)}…` : said;
}

/** The end of a start's log, or nothing when it cannot be read. */
async function readOutputTail(file: string): Promise<string> {
  const handle = await fs.promises.open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, OUTPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type StartOutcome = { ok: true } | { ok: false; detail: string };

export interface StartServerAppInput {
  id: string;
  /** The project folder: the working directory, and the folder the listener must run from. */
  directory: string;
  manifest: ClawboxManifest;
  /** The run's PATH, which the command is resolved with first (`startSearchPath` adds where node and bun live beyond it). */
  searchPath: string;
  /** For the tests: never ask systemd for a scope. */
  noScope?: boolean;
  /** For the tests: a shorter wait. */
  waitMs?: number;
}

const inFlight = new Map<string, Promise<StartOutcome>>();

/**
 * The process groups this web server made for app starts — each start's
 * detached child leads one — while their leader lives. `stopServerApp` ends a
 * whole group only when the box made it: a server a coding run started can
 * share a group with the run's agent.
 */
const startedGroups = new Set<number>();

/**
 * Run the manifest's `start` command in the project folder and wait for the
 * project's own listener on the manifest's port. One start per app at a time:
 * a second caller gets the first one's answer. Never throws.
 */
export function startServerApp(input: StartServerAppInput): Promise<StartOutcome> {
  const running = inFlight.get(input.id);
  if (running) return running;
  const attempt = startOnce(input)
    .catch((err): StartOutcome => ({ ok: false, detail: `Starting the app failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }))
    .finally(() => { inFlight.delete(input.id); });
  inFlight.set(input.id, attempt);
  return attempt;
}

async function startOnce(input: StartServerAppInput): Promise<StartOutcome> {
  const { id, directory, manifest, searchPath } = input;
  const port = manifest.port;
  const command = manifest.start;
  if (!APP_ID_RE.test(id) || !isProxyablePort(port) || !command) return { ok: false, detail: "The manifest names no start command." };
  const stat = await fs.promises.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) return { ok: false, detail: "The project folder is gone." };

  // Before anything is spawned: a start without its dependencies only ever
  // exits 127, and this is what lets a retry recover from that.
  const deps = await installAppDependencies({ directory, searchPath });
  if (!deps.ok) return { ok: false, detail: deps.detail };

  const logFile = appServerLogPath(id);
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  const env = appCommandEnv(searchPath, directory, { PORT: String(port) });

  const probe = input.noScope ? null : await probeSystemdRun();
  const scoped = probe?.available && probe.path ? buildAppScopeArgv(probe.path, id, Date.now().toString(36), command) : null;
  // The scope first; a plain detached child when the box has no user manager,
  // or when systemd turned the scope away (it exits before anything listens).
  const plans: { bin: string; argv: string[] }[] = [
    ...(scoped ? [scoped] : []),
    { bin: START_SHELL, argv: ["-c", command] },
  ];
  const waitMs = input.waitMs ?? APP_START_WAIT_MS;
  let exited: number | null = null;
  for (const plan of plans) {
    const log = await fs.promises.open(logFile, "w");
    let child: ChildProcess;
    let gone = false;
    try {
      child = spawn(/* turbopackIgnore: true */ plan.bin, plan.argv, {
        cwd: directory,
        env: env as unknown as NodeJS.ProcessEnv,
        detached: true,
        shell: false,
        stdio: ["ignore", log.fd, log.fd],
      });
      // Listening BEFORE the await below: a command that fails at once can
      // exit while the log is being closed, and an `exit` emitted with nobody
      // listening is gone — the wait would then run its whole length for a
      // server that had already stopped.
      child.once("error", () => { gone = true; });
      child.once("exit", (code) => { gone = true; exited = code; });
      const group = child.pid;
      if (typeof group === "number") {
        startedGroups.add(group);
        child.once("exit", () => { startedGroups.delete(group); });
      }
    } finally {
      await log.close().catch(() => undefined);
    }
    child.unref();

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if ((await listenerOwnedBy(port, directory, { fresh: true })) === "owned") return { ok: true };
      if (gone) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (!gone) {
      // Still running and still silent: end what we started, by its own
      // process group, rather than leave a half-started server behind.
      if (typeof child.pid === "number") await endProcessGroup(child.pid);
      return { ok: false, detail: `the box started it (${command}) and nothing of the project's answered on port ${port} within ${Math.round(waitMs / 1000)} seconds.` };
    }
  }
  const code = exited === null ? "" : ` with exit code ${exited}`;
  // What it printed takes the command's place (the owner can read that in
  // clawbox.json): the feed keeps 160 characters of a step, and a long start
  // command in front would leave none of them for "bun: not found".
  const said = startOutputLine(await readOutputTail(logFile));
  if (said) return { ok: false, detail: `its start command stopped${code} before listening: ${said}` };
  return { ok: false, detail: `the box started it (${command}) and it stopped${code} before anything listened on port ${port}.` };
}

/** How long a start that is being ended gets to go quietly before it is killed. */
const END_GRACE_MS = 3_000;

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End a process group we started: asked first, then made to. A signal is a
 * request — a start command that ignores SIGTERM would otherwise be reported
 * as ended while it kept running.
 */
async function endProcessGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + END_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(-pgid, "SIGKILL"); } catch { /* gone in the meantime */ }
}

// ── Stopping an app's server ─────────────────────────────────────────────────

/** How long a start of the same app that is under way is waited for before a stop gives up. */
const STOP_START_WAIT_MS = 20_000;
/** How long `systemctl --user stop` of an app's scope may take before the scope is killed instead. */
const SCOPE_STOP_TIMEOUT_MS = 10_000;
/** How long the port has, once the server was told to stop, to have none of it listening. */
const STOP_PORT_WAIT_MS = 5_000;

export type StopOutcome =
  /** `holder`: a listener on the port that is NOT the app's, left running (its pid; null when it is another user's). */
  | { ok: true; stopped: boolean; holder: { pid: number | null } | null }
  | { ok: false; detail: string };

/** The process group a pid leads or belongs to, from /proc/<pid>/stat; null when it cannot be read. */
async function processGroupOf(pid: number): Promise<number | null> {
  const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf-8").catch(() => null);
  if (!stat) return null;
  // pid (comm) state ppid pgrp …: comm may hold spaces and parentheses, so count from the last one.
  const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  return Number.isInteger(pgid) && pgid > 1 ? pgid : null;
}

async function appScopeOfPid(pid: number, id: string): Promise<string | null> {
  return appScopeOf(await fs.promises.readFile(`/proc/${pid}/cgroup`, "utf-8").catch(() => ""), id);
}

/** `systemctl --user` from the web server, a system service: `scopeEnv` names the user bus (app-unit-limits.ts says why). */
const systemctlEnv = (): Record<string, string> => scopeEnv({ PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" });

/**
 * The folder a `WorkingDirectory=` read back from `systemctl show` names, or
 * null when it names none. systemd prints `!` in front of one that may be
 * missing and `~` for the home folder. Exported for its test.
 */
export function unitWorkingDirectory(value: string): string | null {
  const dir = value.trim().replace(/^!/, "");
  if (dir === "~") return os.homedir();
  return path.isAbsolute(dir) ? path.resolve(dir) : null;
}

/**
 * The user `.service` an app's server runs in when that unit is the app's: the
 * agent sometimes serves a registered app from a
 * `~/.config/systemd/user/<app>-app.service` of its own (app-unit-limits.ts).
 * Ending only its process would not stop it: under `Restart=` systemd starts
 * it again from the same folder, and the port is taken again. The unit is the
 * app's only when its own `WorkingDirectory=` is in the app's folder; a unit
 * with merely one process there (an owner's shell service, a CI runner) is
 * never stopped whole. Never one of the box's own (`clawbox-*`).
 */
async function appUserServiceOf(cgroup: string, real: string): Promise<string | null> {
  // On demand: app-unit-limits.ts imports this module.
  const { foreignUserServiceOf, showProperties } = await import("@/lib/app-unit-limits");
  const unit = foreignUserServiceOf(cgroup);
  if (!unit) return null;
  const systemctl = await findSystemdTool("systemctl");
  if (!systemctl) return null;
  const shown = await runChild(systemctl, ["--user", "show", "-p", "WorkingDirectory", "--", unit], { timeoutMs: 5_000, env: systemctlEnv() });
  if (shown.code !== 0) return null;
  const dir = unitWorkingDirectory(showProperties(shown.stdout).WorkingDirectory ?? "");
  if (!dir) return null;
  const realDir = await fs.promises.realpath(dir).catch(() => dir);
  return isInside(realDir, real) ? unit : null;
}

/** The unit an app's server runs in, when stopping that unit is what stops the server. */
interface AppProcess {
  /** `clawbox-app-<id>-<stamp>.scope`: the box's own start. */
  scope: string | null;
  /** The app's own user `.service` (`appUserServiceOf`). */
  unit: string | null;
}

/**
 * Is this process the app's own server? Proven, never assumed from the port
 * (a manifest can name any port, the gateway's included):
 *  - it runs in the scope the box starts this app in (`appScopeOf`), or
 *  - its working directory is in the app's folder — or WAS, in a folder of
 *    that name since removed (`processCwd` reads the kernel's "(deleted)").
 * Null when it is not the app's, and always for the web server itself.
 */
async function appProcess(pid: number, id: string, real: string | null): Promise<AppProcess | null> {
  if (pid === process.pid) return null;
  const cgroup = await fs.promises.readFile(`/proc/${pid}/cgroup`, "utf-8").catch(() => "");
  const scope = appScopeOf(cgroup, id);
  if (scope) return { scope, unit: null };
  if (!real) return null;
  const cwd = await processCwd(pid);
  if (!cwd || !isInside(cwd.path, real)) return null;
  return { scope: null, unit: await appUserServiceOf(cgroup, real) };
}

/** systemd's own stop for the unit, bounded: a server that will not go on SIGTERM is killed instead. */
async function stopUserUnit(unit: string): Promise<void> {
  const systemctl = await findSystemdTool("systemctl");
  if (!systemctl) return;
  const env = systemctlEnv();
  const stop = await runChild(systemctl, ["--user", "stop", "--", unit], { timeoutMs: SCOPE_STOP_TIMEOUT_MS, env });
  if (stop.code === 0) return;
  await runChild(systemctl, ["--user", "kill", "--signal=SIGKILL", "--", unit], { timeoutMs: 5_000, env });
}

/**
 * The app's own `.service` no longer starts at boot: its folder is going.
 * The unit file stays where its writer put it, outside the app's folder —
 * disabled, it does nothing. Best effort: a unit with no `[Install]` section,
 * or one enabled for every user, has nothing here to undo.
 */
async function disableUserUnit(unit: string): Promise<void> {
  const systemctl = await findSystemdTool("systemctl");
  if (!systemctl) return;
  const disabled = await runChild(systemctl, ["--user", "disable", "--", unit], { timeoutMs: 10_000, env: systemctlEnv() });
  if (disabled.code !== 0) console.warn(`[apps] ${unit} could not be disabled: ${(disabled.stderr || disabled.stdout).trim().slice(0, 200)}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ended by its process group when the box made that group, by itself otherwise; asked first, then made to. */
async function endAppProcess(pid: number, id: string): Promise<void> {
  const group = await processGroupOf(pid);
  const ownGroup = await processGroupOf(process.pid);
  // Never the web server's own group, and never a group the box did not make:
  // a server a coding run started can share its group with the run's agent,
  // whose working directory is in the project folder too. The group is the
  // server's own when it leads it, the box's when a start of this web server
  // made it or its leader is in the app's scope; otherwise only the server
  // itself is ended.
  if (group && group !== ownGroup && group !== process.pid && (group === pid || startedGroups.has(group) || (await appScopeOfPid(group, id)))) {
    await endProcessGroup(group);
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + END_GRACE_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone in the meantime */ }
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return settled;
}

/**
 * Stop the server an app runs on `port` — only one that is provably this
 * app's (`appProcess`), never whatever holds the port. Its scope — or the
 * app's own user `.service`, whose `Restart=` would bring it back — goes with
 * systemd's own `systemctl --user stop`; a server outside a unit (a box with
 * no user manager, a run's own) by its process group. Answers once none of
 * the app's is listening any more, and forgets the proxy's cached verdict
 * for the port. A start of the same app still under way is waited for first:
 * it would bring the server up again behind the stop.
 *
 * `disableUnit`: the app is being removed, so its own `.service` is disabled
 * too, never to start at boot from a folder that is gone.
 *
 * `ok: false` only when the app's server is still listening, or the box could
 * not tell: a caller about to remove the app's folder must not go on then.
 * A listener that is not the app's is left alone and named in `holder`.
 * Never throws.
 */
export async function stopServerApp(
  id: string,
  where: { port: number; directory: string | null },
  options: { disableUnit?: boolean } = {},
): Promise<StopOutcome> {
  const { port } = where;
  if (!APP_ID_RE.test(id) || !isProxyablePort(port)) return { ok: true, stopped: false, holder: null };
  try {
    const directory = where.directory ? path.resolve(where.directory) : null;
    const pending = inFlight.get(id) ?? (directory ? installing.get(directory) : undefined);
    if (pending && !(await settledWithin(pending, STOP_START_WAIT_MS))) {
      return { ok: false, detail: "The app's server is still being started. Try again once it is up." };
    }
    const real = directory ? await fs.promises.realpath(directory).catch(() => directory) : null;

    const find = async () => {
      const found = await portListeners(port);
      if (!found) return null;
      const ours = new Map<number, AppProcess>();
      let holder: { pid: number | null } | null = found.listening && found.pids.length === 0 ? { pid: null } : null;
      for (const pid of found.pids) {
        const own = await appProcess(pid, id, real);
        if (own) ours.set(pid, own);
        else holder ??= { pid };
      }
      return { ours, holder };
    };

    const first = await find();
    if (!first) return { ok: false, detail: `The box could not tell who is listening on port ${port} (the socket listing failed).` };
    if (first.ours.size === 0) return { ok: true, stopped: false, holder: first.holder };

    const owned = [...first.ours.values()];
    for (const scope of new Set(owned.map((p) => p.scope).filter((s): s is string => !!s))) await stopUserUnit(scope);
    for (const unit of new Set(owned.map((p) => p.unit).filter((u): u is string => !!u))) {
      await stopUserUnit(unit);
      if (options.disableUnit) await disableUserUnit(unit);
    }
    // Outside a unit, or one systemd could not be asked to stop.
    for (const pid of first.ours.keys()) {
      if (pidAlive(pid)) await endAppProcess(pid, id);
    }

    const deadline = Date.now() + STOP_PORT_WAIT_MS;
    for (;;) {
      const now = await find();
      if (now && now.ours.size === 0) {
        forgetListenerVerdict(port);
        return { ok: true, stopped: true, holder: now.holder };
      }
      if (Date.now() >= deadline) {
        const still = now ? ` (pid ${[...now.ours.keys()][0]})` : "";
        return { ok: false, detail: `The app's server${still} is still listening on port ${port}.` };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (err) {
    return { ok: false, detail: `Stopping the app's server failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
}

/** The refusal for a port a process that is not the app's holds. */
export function portTakenBy(port: number, pid: number | null): string {
  return pid === null ? `Port ${port} is taken by another user's process.` : `Port ${port} is taken by another process (pid ${pid}).`;
}

/**
 * Register a project's server app, starting the server first when the only
 * thing in the way is that nothing is listening and the manifest says how to
 * start it.
 *
 * A port that is taken is reclaimed only from the app's OWN leftover server:
 * one in this app's scope, or running from its folder as it was before the
 * folder was removed (an uninstall before the box stopped servers, a folder
 * deleted by hand). That one is stopped and a fresh one started. Anything
 * else keeps the port and is named in the refusal; the app is never moved to
 * another port. A listing that failed is returned as it is.
 */
export async function registerOrStartServerApp(input: StartServerAppInput): Promise<RegisterOutcome> {
  const { id, directory, manifest } = input;
  const first = await registerServerApp({ id, directory, manifest });
  if (first.ok || !manifest.start || !manifest.port) return first;
  if (first.reason === "not_owned") {
    const freed = await stopServerApp(id, { port: manifest.port, directory });
    if (!freed.ok) return { ok: false, reason: "not_owned", detail: freed.detail };
    if (freed.holder) return { ok: false, reason: "not_owned", detail: portTakenBy(manifest.port, freed.holder.pid) };
  } else if (first.reason !== "not_listening") {
    return first;
  }
  const started = await startServerApp(input);
  if (!started.ok) return { ok: false, reason: "not_listening", detail: started.detail };
  return registerServerApp({ id, directory, manifest });
}

/**
 * Bring back the app servers that were on the desktop before the box rebooted.
 *
 * WHY A BOOT PASS AND NOT A SYSTEMD UNIT. The scope a start runs in already
 * outlives the web server (that is what `buildAppScopeArgv` is for), so an
 * in-app update — `systemctl restart clawbox-setup` — does not end an app. A
 * REBOOT does. The box used to leave that to the owner, and what owners did was
 * hand-write a `clawbox-app-<id>.service` of their own: unmanaged, uncapped,
 * outside every update, and invisible to the desktop it serves. Here the box
 * starts the app itself, in the same capped scope a settle uses, from the
 * `start` command registration recorded in `data/webapps/<id>/meta.json`.
 *
 * WHAT IT WILL NOT DO. Nothing is started that the box did not itself start:
 * a meta without `start` (a static webapp, a legacy stub) is skipped, and so is
 * one that says `"autoStart": false` — the owner's opt-out, written by hand
 * into meta.json. An app whose port already answers is left alone: somebody
 * (a run, the owner's terminal) is already serving it, and a second copy would
 * collide on the port rather than help. A port held by anything but the app
 * is left alone too, and logged; only the app's own leftover is stopped.
 *
 * `CLAWBOX_APP_AUTOSTART=0` in the web server's environment turns the whole
 * pass off, for a box whose owner would rather choose.
 */
export interface BootRestartOptions {
  /** A test's start, instead of the real one. */
  start?: (input: StartServerAppInput) => Promise<StartOutcome>;
  /** A test's webapps folder, instead of the box's. */
  webappsDir?: string;
}

export async function restartServerAppsAtBoot(options: BootRestartOptions = {}): Promise<string[]> {
  if (process.env.CLAWBOX_APP_AUTOSTART === "0") return [];
  const dir = options.webappsDir ?? path.join(DATA_DIR, "webapps");
  const start = options.start ?? startServerApp;
  // Untraced: this runs from the instrumentation entry, whose file trace Next
  // does not exclude the way it excludes a route's. A `readdir` over a path the
  // build believes it knows is a glob over the project, and the build panicked
  // on the first symlink it found in the owner's data/ (a venv a run left).
  const entries = await fs.promises.readdir(untraced(dir), { withFileTypes: true }).catch(() => []);
  const started: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !APP_ID_RE.test(entry.name)) continue;
    const id = entry.name;
    const meta = await fs.promises.readFile(untraced(path.join(dir, id, "meta.json")), "utf-8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (!meta || meta.autoStart === false) continue;
    const command = typeof meta.start === "string" ? meta.start.trim() : "";
    const directory = typeof meta.directory === "string" ? meta.directory : "";
    const port = typeof meta.port === "number" ? meta.port : Number.NaN;
    const name = typeof meta.name === "string" ? meta.name : id;
    if (!command || !isProxyablePort(port) || !directory) continue;
    if (!(await fs.promises.stat(untraced(directory)).catch(() => null))?.isDirectory()) continue;
    // Already up: a run, the owner's terminal, or a start that outlived a
    // web-server restart. Starting a second copy would fail on the port.
    const verdict = await listenerOwnedBy(port, directory);
    if (verdict === "owned") continue;
    // Taken by something that is not the app as it is now: its own leftover
    // (a folder removed and made again under it) is stopped first, exactly as
    // an install again does; anything else keeps the port, and a start that
    // could only die on it is not made.
    if (verdict === "not_owned") {
      const freed = await stopServerApp(id, { port, directory });
      if (!freed.ok || freed.holder) {
        console.error(`[app-boot] ${id} not started: ${freed.ok ? portTakenBy(port, freed.holder?.pid ?? null) : freed.detail}`);
        continue;
      }
    }
    const outcome = await start({ id, directory, manifest: { name, port, start: command, kind: "server" } as ClawboxManifest, searchPath: process.env.PATH ?? "" });
    if (outcome.ok) started.push(id);
    else console.error(`[app-boot] ${id} did not come back: ${outcome.detail}`);
  }
  return started;
}
