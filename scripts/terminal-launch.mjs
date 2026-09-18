// @ts-check
/**
 * Which shell a new terminal runs and which folder it starts in — the part of
 * terminal-server.mjs that decides, in its own module so it can be tested
 * without a server or a PTY.
 *
 * The Terminal's settings let the owner pick both (Settings → Shell). What
 * arrives is only a request: a shell must be one /etc/shells lists AND an
 * executable file here, and a folder must exist and be enterable. Anything
 * else starts the default — bash, the home folder — and the refusal is
 * reported back so the terminal can say what it started instead. The owner
 * already has a shell as this user either way; the checks are about starting
 * something that works, not about fencing the owner in.
 *
 * Plain ESM for the same reason terminal-server.mjs is (see its header).
 * src/lib/terminal-shells.ts is the web server's copy of `parseEtcShells` and
 * `availableShells`, and src/tests/unit/terminal-launch.test.ts runs the same
 * table against both.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_SHELL = "/bin/bash";

/**
 * The absolute paths an /etc/shells file lists, in order, once each.
 * @param {string} text
 * @returns {string[]}
 */
export function parseEtcShells(text) {
  /** @type {string[]} */
  const shells = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (line.startsWith("/") && !/\s/.test(line) && !shells.includes(line)) shells.push(line);
  }
  return shells;
}

/**
 * @param {string} [file]
 * @returns {string[]}
 */
export function readEtcShells(file = "/etc/shells") {
  try {
    return parseEtcShells(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The listed shells that are really here, one entry per binary: a merged-/usr
 * image lists /bin/bash and /usr/bin/bash, which are the same file.
 * @param {string[]} listed
 * @returns {string[]}
 */
export function availableShells(listed) {
  const seen = new Set();
  /** @type {string[]} */
  const shells = [];
  for (const shell of listed) {
    if (!isExecutableFile(shell)) continue;
    let real = shell;
    try {
      real = fs.realpathSync(shell);
    } catch {
      /* keep the listed name */
    }
    if (seen.has(real)) continue;
    seen.add(real);
    shells.push(shell);
  }
  return shells;
}

/**
 * @param {string | null | undefined} requested
 * @param {string[]} listed  what /etc/shells lists
 * @param {string} [fallback]
 * @returns {{ shell: string, refused: string | null }}
 */
export function resolveShell(requested, listed, fallback = DEFAULT_SHELL) {
  const value = (requested ?? "").trim();
  if (!value) return { shell: fallback, refused: null };
  if (listed.includes(value) && isExecutableFile(value)) return { shell: value, refused: null };
  return { shell: fallback, refused: value };
}

/**
 * `""` and `~` are the home folder, `~/x` is under it, a relative path is taken
 * from it, and an absolute one is itself — if it is a folder this user can
 * enter.
 * @param {string | null | undefined} requested
 * @param {string} home
 * @returns {{ cwd: string, refused: string | null }}
 */
export function resolveCwd(requested, home) {
  const value = (requested ?? "").trim();
  if (!value || value === "~" || value === "~/") return { cwd: home, refused: null };
  // eslint-disable-next-line no-control-regex
  if (value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return { cwd: home, refused: value };
  const target = value.startsWith("~/")
    ? path.join(home, value.slice(2))
    : path.resolve(home, value);
  try {
    if (fs.statSync(target).isDirectory()) {
      fs.accessSync(target, fs.constants.X_OK);
      return { cwd: target, refused: null };
    }
  } catch {
    /* missing, or not ours to enter */
  }
  return { cwd: home, refused: value };
}
