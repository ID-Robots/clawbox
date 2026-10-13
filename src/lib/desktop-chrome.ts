/**
 * The owner's own Google Chrome, opened as a native window on the "ClawBox
 * Desktop" session (monitor mode, the x64 laptop's labwc session).
 *
 * The desktop is itself a Chrome `--app` window, and a page it opens with
 * `window.open` lands in a window of THAT Chrome — the kiosk profile, which
 * holds the desktop and nothing else of the owner's. The Google Chrome icon is
 * the other browser: the one the owner signs into, with their profile, their
 * passwords and their extensions, the same Chrome they had before the box ran
 * this session. A second launch while it is up opens a new window in the
 * running one (Chrome hands its argv to the process holding the profile), so
 * the icon never starts a second browser.
 *
 * WHERE IT RUNS. The web server is a system service; the Chrome it starts has
 * to be on the session's Wayland display and must not die with the server, so
 * it goes into a transient unit of the user's systemd manager
 * (`systemd-run --user`) rather than the server's own cgroup — a restart of
 * the web server would otherwise take the owner's browser, tabs and all, with
 * it. Without a user manager it is a detached child of the server, which DOES
 * share the server's cgroup and dies with a restart: the launch says so
 * (`survivesRestart: false`) rather than promising otherwise.
 *
 * WHEN. Only while the ClawBox Desktop session is up (`monitorModeSession`)
 * on a box with a kiosk (`kioskConfigured`) and a Chrome to start: every
 * Jetson, and the laptop under any other session, answers `available: false`
 * and the desktop draws no icon.
 *
 * What the owner may set, in the web server's environment:
 *  - `CLAWBOX_DESKTOP_CHROME` — the binary (default: the first of
 *    google-chrome-stable / google-chrome on PATH, then /opt/google/chrome/chrome);
 *  - `CLAWBOX_DESKTOP_CHROME_ARGS` — extra flags, split on whitespace; `\ `
 *    keeps a space inside one (`--profile-directory=Profile\ 1`).
 */
import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "./runtime-path";
import { kioskConfigured } from "./kiosk-env";
import { findWaylandDisplays, monitorModeSession, type WaylandDisplay } from "./monitors";
import { findSystemdTool } from "./coding-run-unit";

export interface DesktopChromeStatus {
  available: boolean;
}

export type DesktopChromeLaunch =
  | { ok: true; available: true; survivesRestart: boolean }
  | { ok: false; available: false }
  | { ok: false; available: true; error: string; code: string };

/** Where the start page lands when the caller names none. */
export const DEFAULT_CHROME_URL = "https://www.google.com/";
/** systemd-run's own ceiling: it returns as soon as the unit is started. */
const LAUNCH_TIMEOUT_MS = 10_000;
const UNIT_PREFIX = "clawbox-chrome-";

const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome"];
const CHROME_FALLBACK = "/opt/google/chrome/chrome";

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(/* turbopackIgnore: true */ file);
    if (!st.isFile()) return false;
    fs.accessSync(/* turbopackIgnore: true */ file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The Chrome binary to start, or null when this box has none. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CLAWBOX_DESKTOP_CHROME?.trim();
  if (configured) return path.isAbsolute(configured) && isExecutable(configured) ? configured : null;
  const dirs = (env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
  for (const name of CHROME_CANDIDATES) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return isExecutable(CHROME_FALLBACK) ? CHROME_FALLBACK : null;
}

/** `CLAWBOX_DESKTOP_CHROME_ARGS`, split on unescaped whitespace (`\ ` keeps a space). */
export function parseChromeArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && raw[i + 1] === " ") {
      cur += " ";
      has = true;
      i++;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** The ClawBox Desktop session's Wayland display, or null when that session is not up. */
export function desktopSessionDisplay(): WaylandDisplay | null {
  if (!kioskConfigured()) return null;
  for (const display of findWaylandDisplays()) {
    if (monitorModeSession(display.runtimeDir) !== null) return display;
  }
  return null;
}

export function desktopChromeStatus(): DesktopChromeStatus {
  return { available: desktopSessionDisplay() !== null && findChrome() !== null };
}

/** http(s) only; anything else is refused rather than handed to Chrome's argv. */
export function chromeUrl(url: unknown): string | null {
  if (url === undefined || url === null || url === "") return DEFAULT_CHROME_URL;
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Chrome's argv: the owner's flags, Wayland, then the page in a NEW window. */
export function buildChromeArgv(url: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...parseChromeArgs(env.CLAWBOX_DESKTOP_CHROME_ARGS), "--ozone-platform=wayland", "--new-window", url];
}

/** The environment Chrome starts with: the session's display and nothing of the server's secrets. */
export function chromeEnv(display: WaylandDisplay, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    NODE_ENV: env.NODE_ENV,
    HOME: env.HOME || os.homedir(),
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: env.LANG || "C.UTF-8",
    XDG_RUNTIME_DIR: display.runtimeDir,
    WAYLAND_DISPLAY: display.display,
    XDG_SESSION_TYPE: "wayland",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${display.runtimeDir}/bus`,
  };
}

/**
 * systemd expands `$NAME` / `${NAME}` in a unit's command line, so a page URL
 * such as `https://example.com/$HOME` would reach Chrome rewritten; `$$` is its
 * literal dollar. Only for the systemd-run path — the direct spawn gets argv as is.
 */
export function escapeSystemdArgv(argv: string[]): string[] {
  return argv.map((a) => a.replace(/\$/g, "$$$$"));
}

/**
 * Start `bin` as a detached child of THIS process. Resolves once the process
 * exists (`spawn`), rejects when it could not be started (`error`), so a
 * missing or unrunnable binary is a failed launch, not a 200. The child stays
 * in the web server's cgroup: a service restart takes it along.
 */
function runDetached(bin: string, argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ bin, argv, { env, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function launchDetached(bin: string, argv: string[], env: NodeJS.ProcessEnv): Promise<DesktopChromeLaunch> {
  try {
    await runDetached(bin, argv, env);
    return { ok: true, available: true, survivesRestart: false };
  } catch (err) {
    return {
      ok: false,
      available: true,
      error: `Google Chrome could not be started: ${err instanceof Error ? err.message : String(err)}`,
      code: "launch_failed",
    };
  }
}

/** Open Google Chrome on the desktop session's screen, on `url` (http(s); Google when absent). */
export async function launchDesktopChrome(rawUrl?: unknown): Promise<DesktopChromeLaunch> {
  const display = desktopSessionDisplay();
  const chrome = findChrome();
  if (!display || !chrome) return { ok: false, available: false };
  const url = chromeUrl(rawUrl);
  if (!url) return { ok: false, available: true, error: "Only http(s) pages can be opened", code: "invalid_url" };

  const env = chromeEnv(display);
  const argv = buildChromeArgv(url);
  const systemdRun = fs.existsSync(/* turbopackIgnore: true */ `${display.runtimeDir}/bus`)
    ? await findSystemdTool("systemd-run")
    : null;
  if (!systemdRun) return launchDetached(chrome, argv, env);

  // NODE_ENV is the server's, not the browser's.
  const setenv = Object.entries(env)
    .filter(([k, v]) => k !== "NODE_ENV" && typeof v === "string")
    .map(([k, v]) => `--setenv=${k}=${v}`);
  const unit = `${UNIT_PREFIX}${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    execFile(
      /* turbopackIgnore: true */ systemdRun,
      // Type=exec: systemd-run returns only once Chrome's execve() succeeded,
      // so a binary that cannot start fails here instead of answering success.
      ["--user", `--unit=${unit}`, "--collect", "--quiet", "--property=Type=exec", ...setenv, "--", chrome, ...escapeSystemdArgv(argv)],
      { env, timeout: LAUNCH_TIMEOUT_MS },
      (err: Error | null) => {
        if (!err) {
          resolve({ ok: true, available: true, survivesRestart: true });
          return;
        }
        // The user manager refused the unit: still the owner's browser, just
        // tied to the web server's lifetime (and reported as such).
        void launchDetached(chrome, argv, env).then(resolve);
      },
    );
  });
}
