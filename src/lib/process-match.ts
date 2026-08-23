import fs from "fs/promises";
import path from "path";

/**
 * Finding processes by what they ARE, not by a regex over their command line.
 *
 * `pkill -f <regex>` matches the regex against every process's FULL argv, and
 * on this device one of those argv arrays is the customer's own text: the
 * Hermes harness runs each chat turn as `hermes chat -q <the user's message>`,
 * so whatever they typed becomes a command-line argument of a live process. A
 * message that happened to contain the browser's match pattern therefore
 * selected the very process answering it and terminated the turn mid-reply.
 * (The harness reports that as a bare exit code, so the customer saw a number,
 * not a cause.) The browser unit already carries a note about an earlier
 * pattern being "broad enough to kill unrelated procs" — this is the same
 * hazard, reached from user input instead of from a neighbouring daemon.
 *
 * The fix is to stop matching on text a message can contain. Callers supply a
 * predicate over the parsed argv, and every predicate here anchors on argv[0]
 * — the executable — before looking at anything else. That is the part a chat
 * message cannot forge: a customer can put any string in argv[1..] of the
 * harness, but they cannot make the harness's argv[0] be `/…/chrome`.
 *
 * Reading /proc directly also removes the pgrep/pkill subprocesses, so the
 * match is exact rather than a regex over a rendered command line.
 */

const PROC_DIR = "/proc";

/**
 * Executable basenames that count as "a browser we launched". Chromium ships
 * its renderer/zygote/GPU children under the same binary (distinguished only by
 * `--type=`), so matching the basename covers the whole tree.
 */
const BROWSER_EXECUTABLES: ReadonlySet<string> = new Set([
  "chrome",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "headless_shell",
]);

/** Path comparison helper — `/a/b/` and `/a/b` name the same directory. */
function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The executable name from an argv[0], with the noise /proc adds stripped.
 * `/…/ms-playwright/chromium-1181/chrome-linux/chrome` → `chrome`.
 */
function executableName(argv0: string): string {
  // A trailing " (deleted)" appears after an in-place upgrade.
  return path.basename(argv0.trim().replace(/ \(deleted\)$/, ""));
}

/** True when argv[0] names a browser binary rather than merely mentioning one. */
export function isBrowserExecutable(argv0: string): boolean {
  return BROWSER_EXECUTABLES.has(executableName(argv0));
}

/**
 * True when this argv belongs to the ClawBox-managed browser.
 *
 * Exported separately from the /proc scan so the rule can be tested against
 * hand-written argv arrays — including the one that caused the bug: a Hermes
 * chat turn whose message argument contains the old match pattern verbatim.
 */
export function isClawboxBrowserArgv(
  argv: readonly string[],
  options: { profileDir: string; cdpPort: number },
): boolean {
  if (argv.length === 0) return false;
  // The load-bearing check. Everything after this point is only narrowing a
  // set of real browser processes down to the one instance we manage.
  if (!isBrowserExecutable(argv[0])) return false;

  // The PROFILE DIRECTORY is the identity, alone.
  //
  // It covers the whole tree: launch-browser.sh passes `--user-data-dir` to
  // the parent, and Chromium hands it down to its renderer/GPU/zygote
  // children. And it is genuinely ours — Chromium singleton-locks a profile
  // directory, so a second instance cannot share it.
  //
  // The CDP port is NOT an identity, and matching it here was TASK-515: the
  // OpenClaw gateway launches its own HEADLESS browser on the same port
  // (`--remote-debugging-port=18800`, profile ~/.openclaw/browser/…), so a
  // port clause classified the agent's invisible browser as the desktop one.
  // The status panel then claimed a desktop browser was running with the
  // headless PID, and close-browser would have SIGTERMed the agent's browser
  // mid-turn. A browser answering our port that is not on our profile is a
  // DIFFERENT browser — see isForeignCdpBrowserArgv below.
  return argvMatchesProfileDir(argv, options.profileDir);
}

/** True when some argument names `profileDir` as the browser's profile. */
function argvMatchesProfileDir(argv: readonly string[], dir: string): boolean {
  const profileDir = trimSlashes(dir);
  return argv.some((arg, i) => {
    if (i === 0) return false;
    // Match the switch NAME exactly. `startsWith("--user-data-dir")` would also
    // accept `--user-data-directory=…`, letting an unrelated Chromium be
    // classified as ours — and callers terminate what this returns.
    if (arg.startsWith("--user-data-dir=")) {
      return trimSlashes(arg.slice("--user-data-dir=".length)) === profileDir;
    }
    // The separated `--user-data-dir /path` form puts the path in the next slot.
    if (arg === "--user-data-dir") return trimSlashes(argv[i + 1] ?? "") === profileDir;
    return false;
  });
}

/**
 * True for a browser that OWNS our CDP port but is NOT the desktop browser —
 * in practice the OpenClaw gateway's own headless Chromium, which binds
 * `--remote-debugging-port=18800` with its own profile whenever the agent
 * browses before the owner ever opened the desktop browser (TASK-515).
 *
 * Matched on the parent only (children never carry the port argument), which
 * is enough: SIGTERM to a Chromium browser process shuts down its tree.
 */
export function isForeignCdpBrowserArgv(
  argv: readonly string[],
  options: { profileDir: string; cdpPort: number },
): boolean {
  if (argv.length === 0) return false;
  if (!isBrowserExecutable(argv[0])) return false;
  if (argvMatchesProfileDir(argv, options.profileDir)) return false;
  return argv.some((arg, i) => i > 0 && arg === `--remote-debugging-port=${options.cdpPort}`);
}

/**
 * Read one process's argv from /proc, or null when it is gone / unreadable.
 *
 * Rejects on the executable BEFORE splitting the rest. This runs for every pid
 * under /proc — a few hundred on a running device, and the browser status is
 * polled every 5s while the Browser panel is open — and almost all of them are
 * rejected by argv[0] alone. Splitting a 40-80 element Chromium cmdline (or any
 * other process's) only to discard it was the bulk of the scan's cost.
 */
async function readMatchingProcArgv(
  pid: number,
  accepts: (argv: readonly string[]) => boolean,
  acceptsExecutable: (argv0: string) => boolean,
): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(`${PROC_DIR}/${pid}/cmdline`, "utf-8");
  } catch {
    // Kernel threads have an empty cmdline, and a process can exit between
    // readdir and read. Neither is an error worth surfacing.
    return null;
  }
  if (!raw) return null;
  // /proc cmdline is NUL-separated with a trailing NUL.
  const firstNul = raw.indexOf("\0");
  const argv0 = firstNul < 0 ? raw : raw.slice(0, firstNul);
  if (!argv0 || !acceptsExecutable(argv0)) return null;

  const argv = raw.split("\0").filter((part) => part.length > 0);
  return argv.length > 0 && accepts(argv) ? argv : null;
}

/**
 * PIDs whose argv satisfies `accepts`. The predicate MUST anchor on argv[0]
 * being a specific executable — see this module's header for why anything
 * matching on later arguments is unsafe on this device.
 *
 * `acceptsExecutable` is the argv[0]-only half of the same predicate, used to
 * reject a process before its full command line is parsed.
 *
 * Never returns this process. That is belt-and-braces — the argv[0] rule
 * already excludes the web server and the harness — but a helper whose only job
 * is to produce kill targets should not be able to name its own caller.
 */
export async function findPidsByArgv(
  accepts: (argv: readonly string[]) => boolean,
  acceptsExecutable: (argv0: string) => boolean,
): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROC_DIR);
  } catch {
    return [];
  }

  const self = process.pid;
  const found: number[] = [];

  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return;
    const pid = Number(entry);
    if (pid === self) return;
    if (await readMatchingProcArgv(pid, accepts, acceptsExecutable)) found.push(pid);
  }));

  return found.sort((a, b) => a - b);
}

/** SIGTERM every process matching `accepts`. Returns how many were signalled. */
export async function terminateByArgv(
  accepts: (argv: readonly string[]) => boolean,
  acceptsExecutable: (argv0: string) => boolean,
): Promise<number> {
  const pids = await findPidsByArgv(accepts, acceptsExecutable);
  let signalled = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      signalled += 1;
    } catch {
      // Already gone, or not ours to signal. Both are fine here.
    }
  }
  return signalled;
}

/** PIDs of the ClawBox browser and its children. */
export function findClawboxBrowserPids(options: {
  profileDir: string;
  cdpPort: number;
}): Promise<number[]> {
  return findPidsByArgv((argv) => isClawboxBrowserArgv(argv, options), isBrowserExecutable);
}

/**
 * SIGTERM every ClawBox browser process. Returns how many were signalled.
 *
 * Used as the fallback after `systemctl stop clawbox-browser.service` — the
 * unit's KillMode=control-group already reaps the tree when the browser was
 * started through it, so this only has work to do for an instance started some
 * other way.
 */
export function terminateClawboxBrowser(options: {
  profileDir: string;
  cdpPort: number;
}): Promise<number> {
  return terminateByArgv((argv) => isClawboxBrowserArgv(argv, options), isBrowserExecutable);
}

/** PIDs of a foreign browser holding our CDP port — see isForeignCdpBrowserArgv. */
export function findForeignCdpBrowserPids(options: {
  profileDir: string;
  cdpPort: number;
}): Promise<number[]> {
  return findPidsByArgv((argv) => isForeignCdpBrowserArgv(argv, options), isBrowserExecutable);
}

/**
 * SIGTERM a foreign browser holding our CDP port. Used by open-browser: the
 * desktop browser cannot bind 18800 while the agent's headless browser owns
 * it, and the owner has explicitly asked for a window. The agent relaunches
 * its browser on demand — and after the desktop browser is up, it attaches to
 * that window instead, which is the shared-browser state the panel documents.
 */
export function terminateForeignCdpBrowser(options: {
  profileDir: string;
  cdpPort: number;
}): Promise<number> {
  return terminateByArgv((argv) => isForeignCdpBrowserArgv(argv, options), isBrowserExecutable);
}
