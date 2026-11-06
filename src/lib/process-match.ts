import fs from "fs/promises";
import path from "./runtime-path";

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
  // Chromium builds an owner may name as their own desktop browser
  // (CLAWBOX_BROWSER_EXECUTABLE, src/lib/desktop-browser-config.ts). The list
  // stays fixed rather than taking the configured name: it is what keeps a
  // chat turn's argv from ever qualifying, whatever the config file says.
  "brave",
  "msedge",
  "vivaldi-bin",
]);

/**
 * Which browser instance a caller means: the profile is the identity, the port
 * is where it answers. `ownProfile` false says the profile is the OWNER's (a
 * browser of their own they configured), not ClawBox's private one — see
 * terminateClawboxBrowser for what that changes.
 */
export interface BrowserMatch {
  profileDir: string;
  cdpPort: number;
  ownProfile?: boolean;
}

/** The systemd unit that starts the desktop browser. */
const BROWSER_UNIT = "clawbox-browser.service";

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
  options: BrowserMatch,
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

/** Every profile directory the argv names, trailing slashes trimmed. */
function argvProfileDirs(argv: readonly string[]): string[] {
  const dirs: string[] = [];
  argv.forEach((arg, i) => {
    if (i === 0) return;
    // Match the switch NAME exactly. `startsWith("--user-data-dir")` would also
    // accept `--user-data-directory=…`, letting an unrelated Chromium be
    // classified as ours — and callers terminate what this returns.
    if (arg.startsWith("--user-data-dir=")) dirs.push(trimSlashes(arg.slice("--user-data-dir=".length)));
    // The separated `--user-data-dir /path` form puts the path in the next slot.
    else if (arg === "--user-data-dir") dirs.push(trimSlashes(argv[i + 1] ?? ""));
  });
  return dirs;
}

/** True when some argument names `profileDir` as the browser's profile. */
function argvMatchesProfileDir(argv: readonly string[], dir: string): boolean {
  const profileDir = trimSlashes(dir);
  return argvProfileDirs(argv).includes(profileDir);
}

/** True when the argv carries exactly `--remote-debugging-port=<port>`. */
function argvHasCdpPort(argv: readonly string[], port: number): boolean {
  return argv.some((arg, i) => i > 0 && arg === `--remote-debugging-port=${port}`);
}

/**
 * True for the ASSISTANT's background browser, and for nothing a person is
 * looking at: a headless Chromium (`--headless`, `--headless=new`, or the
 * `headless_shell` build), or one on a profile the OpenClaw gateway manages
 * (`~/.openclaw/browser/<name>/user-data`). Positive identification on
 * purpose — "some other browser on our port" also describes an owner who runs
 * their own signed-in Chrome there, and that one is never ours to close.
 */
export function isAssistantBrowserArgv(argv: readonly string[]): boolean {
  if (argv.length === 0 || !isBrowserExecutable(argv[0])) return false;
  if (executableName(argv[0]) === "headless_shell") return true;
  if (argv.some((arg, i) => i > 0 && (arg === "--headless" || arg.startsWith("--headless=")))) return true;
  return argvProfileDirs(argv).some((dir) => dir.includes("/.openclaw/browser/"));
}

/**
 * True for the configured browser's own top-level process — on the configured
 * profile AND serving the configured port. A process on the profile without
 * the port is the same browser started without remote debugging, which
 * ClawBox cannot drive.
 */
export function isBrowserOnPortArgv(argv: readonly string[], options: BrowserMatch): boolean {
  return isClawboxBrowserArgv(argv, options) && argvHasCdpPort(argv, options.cdpPort);
}

/**
 * True for a browser that OWNS our CDP port but is NOT the desktop browser —
 * in practice the OpenClaw gateway's own headless Chromium, which binds
 * `--remote-debugging-port=18800` with its own profile whenever the agent
 * browses before the owner ever opened the desktop browser (TASK-515).
 *
 * Only the assistant's (isAssistantBrowserArgv): callers TERMINATE what this
 * returns, and a visible browser on another profile is a person's — the
 * owner's own Chrome on the port they configured, or on 18800 before they
 * configured anything. That one is reported as the port being taken, never
 * closed.
 *
 * Matched on the parent only (children never carry the port argument), which
 * is enough: SIGTERM to a Chromium browser process shuts down its tree.
 */
export function isForeignCdpBrowserArgv(
  argv: readonly string[],
  options: BrowserMatch,
): boolean {
  if (argv.length === 0) return false;
  if (!isBrowserExecutable(argv[0])) return false;
  if (argvMatchesProfileDir(argv, options.profileDir)) return false;
  if (!argvHasCdpPort(argv, options.cdpPort)) return false;
  return isAssistantBrowserArgv(argv);
}

/**
 * True for ANY browser holding our CDP port on another profile — the
 * assistant's or a person's. For telling the owner the port is taken; never a
 * kill list (that is isForeignCdpBrowserArgv).
 */
export function isOtherCdpBrowserArgv(
  argv: readonly string[],
  options: BrowserMatch,
): boolean {
  if (argv.length === 0) return false;
  if (!isBrowserExecutable(argv[0])) return false;
  if (argvMatchesProfileDir(argv, options.profileDir)) return false;
  return argvHasCdpPort(argv, options.cdpPort);
}

/**
 * Parse a /proc/<pid>/cmdline into argv.
 *
 * Normally the file is NUL-separated with a trailing NUL. But a LIVE Chromium
 * is not normal: it rewrites its argv in place as one flat space-joined
 * string (its process title), so the whole command line arrives as a single
 * NUL-free element — verified byte-for-byte on a real device (TASK-515),
 * where it made every scan miss the running desktop browser. Fall back to
 * space-splitting for exactly that single-element shape.
 *
 * The fallback does not weaken the argv[0] anchor this module exists for: a
 * chat message always sits inside ONE element of a multi-element,
 * NUL-separated argv (the harness's), which takes the NUL path and is
 * rejected on argv[0]. Only a process that rewrote its own title — or was
 * exec'd with a single spaced argv[0], which a chat message cannot cause —
 * reaches the space path. Paths we match (executable, profile dir) contain
 * no spaces on this device.
 */
export function parseProcCmdline(raw: string): string[] {
  const parts = raw.split("\0").filter((part) => part.length > 0);
  if (parts.length === 1 && parts[0].includes(" ")) {
    return parts[0].split(" ").filter((part) => part.length > 0);
  }
  return parts;
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
  // Fast pre-check on the executable alone. In a normal multi-element cmdline
  // (a NUL before the end) argv[0] ends at the first NUL — spaces and all, so
  // an executable living in a spaced path is preserved. Only the
  // single-element title-rewritten form (Chromium) ends argv[0] at a space.
  const firstNul = raw.indexOf("\0");
  const multiElement = firstNul >= 0 && firstNul < raw.length - 1;
  const single = firstNul < 0 ? raw : raw.slice(0, firstNul);
  const argv0 = multiElement ? single : single.split(" ", 1)[0];
  if (!argv0 || !acceptsExecutable(argv0)) return null;

  const argv = parseProcCmdline(raw);
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
  return (await scanByArgv(accepts, acceptsExecutable)).map((p) => p.pid);
}

/** findPidsByArgv, with each match's argv — for a caller that sorts what it found. */
async function scanByArgv(
  accepts: (argv: readonly string[]) => boolean,
  acceptsExecutable: (argv0: string) => boolean,
): Promise<{ pid: number; argv: string[] }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROC_DIR);
  } catch {
    return [];
  }

  const self = process.pid;
  const found: { pid: number; argv: string[] }[] = [];

  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return;
    const pid = Number(entry);
    if (pid === self) return;
    const argv = await readMatchingProcArgv(pid, accepts, acceptsExecutable);
    if (argv) found.push({ pid, argv });
  }));

  return found.sort((a, b) => a.pid - b.pid);
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
export function findClawboxBrowserPids(options: BrowserMatch): Promise<number[]> {
  return findPidsByArgv((argv) => isClawboxBrowserArgv(argv, options), isBrowserExecutable);
}

/** PIDs of the configured browser's top-level process serving the configured port. */
export function findBrowserOnPortPids(options: BrowserMatch): Promise<number[]> {
  return findPidsByArgv((argv) => isBrowserOnPortArgv(argv, options), isBrowserExecutable);
}

/**
 * Did `clawbox-browser.service` start this process? Its cgroup says so: every
 * process the unit starts, and every child of those, sits in the unit's
 * cgroup (`0::/system.slice/clawbox-browser.service` on cgroup v2), and
 * nothing the owner starts from their desktop does. Unreadable means no.
 */
export async function isStartedByBrowserUnit(pid: number): Promise<boolean> {
  try {
    const cgroup = await fs.readFile(`${PROC_DIR}/${pid}/cgroup`, "utf-8");
    return cgroup.split("\n").some((line) => line.split("/").includes(BROWSER_UNIT));
  } catch {
    return false;
  }
}

/**
 * The configured browser's processes from one walk of /proc: their pids, whether
 * any of them was started with the configured port (one that was is starting
 * or serving; one that was not can never answer there), and which of them
 * ClawBox's unit started.
 */
export async function inspectClawboxBrowser(options: BrowserMatch): Promise<{
  pids: number[];
  servingPort: boolean;
  startedByUnit: number[];
}> {
  const found = await scanByArgv((argv) => isClawboxBrowserArgv(argv, options), isBrowserExecutable);
  const pids = found.map((p) => p.pid);
  const started = await Promise.all(pids.map((pid) => isStartedByBrowserUnit(pid)));
  return {
    pids,
    servingPort: found.some((p) => argvHasCdpPort(p.argv, options.cdpPort)),
    startedByUnit: pids.filter((_, i) => started[i]),
  };
}

/** PIDs of the configured browser that ClawBox's unit started — see terminateClawboxBrowser. */
export async function findBrowserPidsStartedByUnit(options: BrowserMatch): Promise<number[]> {
  const pids = await findClawboxBrowserPids(options);
  const started = await Promise.all(pids.map((pid) => isStartedByBrowserUnit(pid)));
  return pids.filter((_, i) => started[i]);
}

/**
 * SIGTERM every ClawBox browser process. Returns how many were signalled.
 *
 * Used as the fallback after `systemctl stop clawbox-browser.service` — the
 * unit's KillMode=control-group already reaps the tree when the browser was
 * started through it, so this only has work to do for an instance started some
 * other way.
 *
 * On ClawBox's own profile, "some other way" is still ClawBox: nobody else
 * runs that profile. On the OWNER's profile (`ownProfile: false`) it is
 * usually the owner, starting their own browser from their own desktop — so
 * there only a process the unit started is signalled, and a browser ClawBox
 * did not start is never closed by ClawBox.
 */
export async function terminateClawboxBrowser(options: BrowserMatch): Promise<number> {
  if (options.ownProfile !== false) {
    return terminateByArgv((argv) => isClawboxBrowserArgv(argv, options), isBrowserExecutable);
  }
  let signalled = 0;
  for (const pid of await findBrowserPidsStartedByUnit(options)) {
    try {
      process.kill(pid, "SIGTERM");
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}

/** PIDs of a foreign browser holding our CDP port — see isForeignCdpBrowserArgv. */
export function findForeignCdpBrowserPids(options: BrowserMatch): Promise<number[]> {
  return findPidsByArgv((argv) => isForeignCdpBrowserArgv(argv, options), isBrowserExecutable);
}

/**
 * Who, besides the configured browser, holds our CDP port: the assistant's
 * background browser(s) and anybody else's, from one walk of /proc.
 */
export async function findCdpPortHolders(options: BrowserMatch): Promise<{ assistant: number[]; other: number[] }> {
  const holders = await scanByArgv((argv) => isOtherCdpBrowserArgv(argv, options), isBrowserExecutable);
  return {
    assistant: holders.filter((h) => isAssistantBrowserArgv(h.argv)).map((h) => h.pid),
    other: holders.filter((h) => !isAssistantBrowserArgv(h.argv)).map((h) => h.pid),
  };
}

/**
 * SIGTERM the assistant's background browser holding our CDP port. Used by
 * open-browser: the desktop browser cannot bind the port while the agent's
 * headless browser owns it, and the owner has explicitly asked for a window.
 * The agent relaunches its browser on demand — and after the desktop browser
 * is up, it attaches to that window instead, which is the shared-browser
 * state the panel documents. A person's browser on the port is left alone
 * (isForeignCdpBrowserArgv).
 */
export function terminateForeignCdpBrowser(options: BrowserMatch): Promise<number> {
  return terminateByArgv((argv) => isForeignCdpBrowserArgv(argv, options), isBrowserExecutable);
}
