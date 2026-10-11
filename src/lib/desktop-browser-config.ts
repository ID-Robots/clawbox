/**
 * WHICH browser the Browser app means: its profile directory, its DevTools
 * (CDP) port and the executable that starts it.
 *
 * ONE source, read by every party that has to agree on it — the launch script
 * systemd runs (scripts/launch-browser.sh), the browser routes' status, open
 * and close, the coding agent's CDP attach (setup-api/browser), the kiosk's
 * tab list (which must never dial this port) and the factory reset. Each used
 * to carry its own `18800` and `~/.config/clawbox-browser`, so on a box whose
 * owner already ran a signed-in Chrome of their own on the desktop, "Open
 * Browser" started a second, empty, signed-out window beside it, and the app
 * said "Not running" while the owner's browser was open.
 *
 * Where it lives: three keys in the launch env file the start page already
 * goes through (written by browser-setup.ts, sourced by the launch script),
 * each overridable from the environment — the web server's unit and the
 * browser's unit both load the checkout's `.env`, so a line there reaches both:
 *
 *   CLAWBOX_BROWSER_PROFILE_DIR=~/.config/my-chrome
 *   CLAWBOX_BROWSER_CDP_PORT=9222
 *   CLAWBOX_BROWSER_EXECUTABLE=/opt/google/chrome/chrome
 *
 * Absent, empty or unusable, each one falls back to exactly what was
 * hard-coded before: ClawBox's own profile, port 18800, and whatever Chromium
 * the launch script finds on its own. The script applies the same rules in
 * bash; src/tests/unit/desktop-browser-config.test.ts runs both over the same
 * files so the two cannot drift.
 *
 * Imports nothing but `fs/promises` and `./runtime-path`, so any src/lib
 * module can read it without pulling in the server runtime.
 */
import fs from "fs/promises";
import path from "./runtime-path";

export type EnvLike = Record<string, string | undefined>;

export const PROFILE_DIR_KEY = "CLAWBOX_BROWSER_PROFILE_DIR";
export const CDP_PORT_KEY = "CLAWBOX_BROWSER_CDP_PORT";
export const EXECUTABLE_KEY = "CLAWBOX_BROWSER_EXECUTABLE";
/** Points the launch env file somewhere else — the suite points it at nowhere. */
export const ENV_FILE_OVERRIDE_KEY = "CLAWBOX_BROWSER_ENV_FILE";

export const DEFAULT_CDP_PORT = 18800;
/** The unit that starts the browser. Whatever runs in its cgroup, ClawBox started. */
export const BROWSER_UNIT = "clawbox-browser.service";

const CLAWBOX_USER = process.env.SUDO_USER || process.env.USER || "clawbox";
/** The home the browser runs in — the unit's `HOME`, whoever runs this server. */
export const BROWSER_HOME = CLAWBOX_USER === "root" ? "/home/clawbox" : `/home/${CLAWBOX_USER}`;

/** ClawBox's own profile — the one nobody but ClawBox ever runs. */
export function defaultProfileDir(home = BROWSER_HOME): string {
  return path.join(home, ".config", "clawbox-browser");
}

/** The launch env file, beside the VNC display the launch script already reads. */
export function browserEnvFile(env: EnvLike = process.env, home = BROWSER_HOME): string {
  return env[ENV_FILE_OVERRIDE_KEY] || path.join(home, ".cache", "clawbox", "browser.env");
}

export interface DesktopBrowserConfig {
  profileDir: string;
  cdpPort: number;
  /** An absolute path, or null for "the Chromium the launch script finds itself". */
  executable: string | null;
  /**
   * The profile is ClawBox's own. When it is not, the profile is the OWNER's,
   * and a browser on it may be one they started themselves — so nothing may
   * kill it, and nothing may touch its lock files, unless ClawBox started it.
   */
  ownProfile: boolean;
  /** Why a configured value was set aside for its default; empty when none was. */
  warnings: string[];
}

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * `KEY=value` lines the way a shell `source` reads the simple cases: optional
 * `export`, a value in single or double quotes or none, a trailing `# …`
 * comment after an unquoted value. The last assignment of a key wins, as it
 * does in bash. Anything cleverer than that (command substitution, a variable
 * other than `$HOME`) is not read here, and the validation below then refuses
 * the value on both sides alike.
 */
export function parseBrowserEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const value = m[2];
    const single = /^'([^']*)'/.exec(value);
    const double = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (single) out[m[1]] = single[1];
    else if (double) out[m[1]] = double[1].replace(/\\(["\\$`])/g, "$1");
    // Unquoted: the shell ends the value at the first blank, and a `#` after
    // that blank starts a comment.
    else out[m[1]] = value.split(/\s/, 1)[0];
  }
  return out;
}

/** `~`, `$HOME` and `${HOME}` at the start of a path, as the shell expands them. */
function expandHome(value: string, home: string): string {
  const m = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(value);
  return m ? home + value.slice(m[0].length) : value;
}

/**
 * An absolute directory with no whitespace, no quote and no `.`/`..` segment,
 * or null. Whitespace because a running Chromium rewrites its command line
 * into ONE space-joined string (process-match.ts) and a spaced path could then
 * never be recognised as this browser's; the quote because the factory reset
 * and the launch script both hand it on; dot segments because the path is
 * compared as written, and the reset removes it.
 */
export function normalizeProfileDir(raw: string, home = BROWSER_HOME): string | null {
  const expanded = expandHome(raw.trim(), home);
  if (!expanded.startsWith("/") || /[\s'"\\\0]/.test(expanded)) return null;
  const trimmed = expanded.replace(/\/+$/, "");
  if (trimmed === "") return null;
  if (trimmed.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return trimmed;
}

/** A port Chromium can bind as an ordinary user: 1024–65535, digits only. */
export function normalizeCdpPort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1024 && port <= 65535 ? port : null;
}

/** An absolute path with no line break in it; whether it exists is the launch's question. */
export function normalizeExecutable(raw: string, home = BROWSER_HOME): string | null {
  const expanded = expandHome(raw.trim(), home);
  if (!expanded.startsWith("/") || /[\n\r\0]/.test(expanded)) return null;
  return expanded;
}

/**
 * The configuration from the file's values and the environment.
 *
 * Per key: the environment if it sets one, else the file, else the default. A
 * value that is set but unusable is a warning and the default, never a guess —
 * the launch script does the same, so the server and the script always name
 * the same profile and port.
 */
export function resolveDesktopBrowserConfig(
  fileValues: Record<string, string>,
  env: EnvLike = process.env,
  home = BROWSER_HOME,
): DesktopBrowserConfig {
  const warnings: string[] = [];
  const pick = (key: string): string | null => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
    const fromFile = fileValues[key];
    return fromFile !== undefined && fromFile.trim() !== "" ? fromFile : null;
  };

  const fallbackProfile = defaultProfileDir(home);
  let profileDir = fallbackProfile;
  const rawProfile = pick(PROFILE_DIR_KEY);
  if (rawProfile !== null) {
    const normalized = normalizeProfileDir(rawProfile, home);
    if (normalized) profileDir = normalized;
    else warnings.push(`${PROFILE_DIR_KEY} must be an absolute path without spaces or quotes; using ${fallbackProfile}`);
  }

  let cdpPort = DEFAULT_CDP_PORT;
  const rawPort = pick(CDP_PORT_KEY);
  if (rawPort !== null) {
    const normalized = normalizeCdpPort(rawPort);
    if (normalized) cdpPort = normalized;
    else warnings.push(`${CDP_PORT_KEY} must be a port from 1024 to 65535; using ${DEFAULT_CDP_PORT}`);
  }

  let executable: string | null = null;
  const rawExecutable = pick(EXECUTABLE_KEY);
  if (rawExecutable !== null) {
    executable = normalizeExecutable(rawExecutable, home);
    if (!executable) warnings.push(`${EXECUTABLE_KEY} must be an absolute path; finding Chromium automatically`);
  }

  return { profileDir, cdpPort, executable, ownProfile: profileDir === fallbackProfile, warnings };
}

/**
 * The configuration as it stands on disk now. Read on every call — the file
 * is a few lines, the callers poll at most every couple of seconds, and an
 * owner who edits it must not have to restart the web server for the app to
 * agree with the script.
 */
export async function readDesktopBrowserConfig(env: EnvLike = process.env): Promise<DesktopBrowserConfig> {
  let raw = "";
  try {
    raw = await fs.readFile(/* turbopackIgnore: true */ browserEnvFile(env), "utf-8");
  } catch {
    // No file yet: nothing configured, every default applies.
  }
  const config = resolveDesktopBrowserConfig(parseBrowserEnv(raw ?? ""), env);
  // Once per distinct warning: the status poll reads this every few seconds.
  for (const warning of config.warnings) {
    if (warned.has(warning)) continue;
    warned.add(warning);
    console.warn(`[browser] ${warning}`);
  }
  return config;
}

const warned = new Set<string>();

/** `http://127.0.0.1:<port>` — the endpoint, and the Origin the launch script allows on it. */
export function cdpEndpoint(config: Pick<DesktopBrowserConfig, "cdpPort">): string {
  return `http://127.0.0.1:${config.cdpPort}`;
}
