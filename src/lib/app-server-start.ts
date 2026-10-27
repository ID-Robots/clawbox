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
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path, { untraced } from "@/lib/runtime-path";
import { listenerOwnedBy, registerServerApp, type RegisterOutcome } from "@/lib/app-proxy";
import { APP_ID_RE } from "@/lib/code-projects";
import { DATA_DIR } from "@/lib/config-store";
import { type ClawboxManifest, isProxyablePort } from "@/lib/clawbox-manifest";
import { probeSystemdRun, scopeEnv } from "@/lib/coding-run-unit";
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

/**
 * `systemd-run`'s prefix in front of the start command. Pure and exported for
 * its test. The unit name is rebuilt from the validated id and a per-start
 * stamp: a scope systemd has not finished collecting would refuse a reused
 * name.
 */
export function buildAppScopeArgv(systemdRunPath: string, id: string, stamp: string, command: string): { bin: string; argv: string[] } | null {
  if (!APP_ID_RE.test(id) || !/^[a-z0-9]{1,16}$/.test(stamp)) return null;
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

  const logFile = appServerLogPath(id);
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  const home = process.env.HOME || directory;
  const user = process.env.USER || process.env.LOGNAME || path.basename(home);
  const env = scopeEnv({
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
    PORT: String(port),
  });

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

/**
 * Register a project's server app, starting the server first when the only
 * thing in the way is that nothing is listening and the manifest says how to
 * start it. Any other refusal — a port that is somebody else's, a listing
 * that failed — is returned as it is: starting a second server would not
 * change it.
 */
export async function registerOrStartServerApp(input: StartServerAppInput): Promise<RegisterOutcome> {
  const { id, directory, manifest } = input;
  const first = await registerServerApp({ id, directory, manifest });
  if (first.ok || first.reason !== "not_listening" || !manifest.start || !manifest.port) return first;
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
 * collide on the port rather than help.
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
    if ((await listenerOwnedBy(port, directory)) === "owned") continue;
    const outcome = await start({ id, directory, manifest: { name, port, start: command, kind: "server" } as ClawboxManifest, searchPath: process.env.PATH ?? "" });
    if (outcome.ok) started.push(id);
    else console.error(`[app-boot] ${id} did not come back: ${outcome.detail}`);
  }
  return started;
}
