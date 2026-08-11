import fs from "fs/promises";
import path from "path";

/**
 * Finding the ClawBox browser's processes WITHOUT pattern-matching whole
 * command lines.
 *
 * `pkill -f <regex>` matches the regex against every process's FULL argv, and
 * on this device one of those argv arrays is the chat turn itself: the Hermes
 * harness is spawned as `hermes chat -q <the user's message> -Q`, so whatever
 * the customer typed becomes a command-line argument of a live process. A
 * message that happened to contain the browser's match pattern therefore
 * selected the very process answering it, and SIGTERM'd the turn mid-answer.
 * (The harness reports that as a bare exit code, so the customer saw a number,
 * not a cause.) The browser unit already carries a note about an earlier
 * pattern being "broad enough to kill unrelated procs" — this is the same
 * hazard, reached from user input instead of from a neighbouring daemon.
 *
 * The fix is to stop matching on text a message can contain. A process is the
 * ClawBox browser only when BOTH hold:
 *
 *   1. argv[0] is an actual browser executable, and
 *   2. some later argument points at OUR profile directory or CDP port.
 *
 * Condition 1 is the one that cannot be forged from a chat message: a customer
 * can put any string in argv[1..] of the harness, but they cannot make the
 * harness's argv[0] be `/…/chrome`. Reading /proc directly also removes the
 * pgrep/pkill subprocesses entirely, so the match is exact rather than a
 * regex over a rendered command line.
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

/** True when argv[0] names a browser binary rather than merely mentioning one. */
export function isBrowserExecutable(argv0: string): boolean {
  const raw = (argv0 || "").trim();
  if (!raw) return false;
  // argv[0] is normally the resolved path Chromium was exec'd with
  // (…/ms-playwright/chromium-1181/chrome-linux/chrome). Compare the basename
  // so a Playwright build and a distro package are treated alike. Strip a
  // trailing " (deleted)" that /proc appends after an in-place upgrade.
  const base = path.basename(raw.replace(/ \(deleted\)$/, ""));
  return BROWSER_EXECUTABLES.has(base);
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

  const profileDir = options.profileDir.replace(/\/+$/, "");
  return argv.slice(1).some((arg) => {
    if (arg.startsWith("--user-data-dir")) {
      // `--user-data-dir=/path` and `--user-data-dir /path` both occur.
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
      const candidate = (value || "").replace(/\/+$/, "");
      if (candidate === profileDir) return true;
    }
    return arg === `--remote-debugging-port=${options.cdpPort}`;
  })
    // A bare `--user-data-dir <path>` puts the path in the NEXT element, so
    // also accept the separated form rather than missing a real browser.
    || argv.some((arg, i) =>
      arg === "--user-data-dir"
      && (argv[i + 1] || "").replace(/\/+$/, "") === profileDir);
}

/** Read one process's argv from /proc, or null when it is gone / unreadable. */
async function readProcArgv(pid: number): Promise<string[] | null> {
  try {
    const raw = await fs.readFile(path.join(PROC_DIR, String(pid), "cmdline"), "utf-8");
    // /proc cmdline is NUL-separated with a trailing NUL.
    const argv = raw.split("\0").filter((part) => part.length > 0);
    return argv.length > 0 ? argv : null;
  } catch {
    // Kernel threads have an empty cmdline, and a process can exit between
    // readdir and read. Neither is an error worth surfacing.
    return null;
  }
}

/**
 * PIDs of the ClawBox browser and its children.
 *
 * Never returns this process. That is belt-and-braces — the argv[0] rule
 * already excludes the web server and the harness — but a helper whose only
 * job is to produce kill targets should not be able to name its own caller.
 */
export async function findClawboxBrowserPids(options: {
  profileDir: string;
  cdpPort: number;
}): Promise<number[]> {
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
    const argv = await readProcArgv(pid);
    if (!argv) return;
    if (isClawboxBrowserArgv(argv, options)) found.push(pid);
  }));

  return found.sort((a, b) => a - b);
}

/**
 * SIGTERM every ClawBox browser process. Returns how many were signalled.
 *
 * Used as the fallback after `systemctl stop clawbox-browser.service` — the
 * unit's KillMode=control-group already reaps the tree when the browser was
 * started through it, so this only has work to do for an instance started
 * some other way.
 */
export async function terminateClawboxBrowser(options: {
  profileDir: string;
  cdpPort: number;
}): Promise<number> {
  const pids = await findClawboxBrowserPids(options);
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
