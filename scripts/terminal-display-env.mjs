// @ts-check
/**
 * The graphical environment a Terminal shell needs (scripts/terminal-server.mjs).
 *
 * The web Terminal is not a desktop session. terminal-server.mjs is started by
 * the web server at boot, and the web server has no DISPLAY — so a shell spawned
 * from the Terminal app has none either, and `xdg-open` (and anything else that
 * asks X or Wayland for a display) exits 3 instead of opening the link. That is
 * true even on a box whose Remote Desktop is up and holding the owner's screen
 * on Xvfb: the display exists, the shell just is not told about it.
 *
 * Resolved here, in this order, and never guessed:
 *
 *   1. this process's own DISPLAY / WAYLAND_DISPLAY — a real desktop session, or
 *      a dev server started from one, already knows better than any file;
 *   2. CLAWBOX_VNC_DISPLAY / CLAWBOX_VNC_XAUTHORITY from
 *      `~/.cache/clawbox/vnc-display.env` — the state file scripts/start-vnc.sh
 *      writes, and the file src/app/setup-api/vnc/clipboard/route.ts already
 *      reads for the same reason;
 *   3. nothing. An unset DISPLAY stays unset: inventing ":99" on a box where VNC
 *      was never started would make clients wait out a connection that cannot
 *      succeed, instead of failing the way they do today.
 *
 * An authority belongs to one display, so the recorded XAUTHORITY travels only
 * with the recorded display; an inherited display keeps only an inherited
 * authority. And a relative WAYLAND_DISPLAY is a socket name, which is only
 * findable through the XDG_RUNTIME_DIR it was inherited with.
 *
 * Owner only — terminal-server.mjs adds this to the owner's shell, not to a
 * scoped ClawBox user's. The display is the owner's desktop: a shell that can
 * reach it can open windows on their screen and read its clipboard, which is not
 * a ClawBox user's to have.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Keys this file will take from the VNC state file, and nothing else. */
const VNC_KEYS = ["CLAWBOX_VNC_DISPLAY", "CLAWBOX_VNC_XAUTHORITY"];

/**
 * A display string an X client can actually use: `:99`, `:0.0`, or
 * `host:0`. Anything else in the file is left alone — this value is put in a
 * child process's environment, so it is read as data, not trusted as config.
 */
const DISPLAY_RE = /^[A-Za-z0-9._-]*:[0-9]+(\.[0-9]+)?$/;

/**
 * Where scripts/start-vnc.sh records the display it started.
 *
 * @param {string} home
 * @returns {string}
 */
export function vncStatePath(home) {
  return path.join(home, ".cache", "clawbox", "vnc-display.env");
}

/**
 * Read the `KEY=value` lines out of the VNC state file. A missing, unreadable
 * or malformed file yields `{}` — every caller then behaves exactly as it did
 * before this module existed, which is the property that keeps a broken state
 * file from being worse than no state file.
 *
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function readVncState(file) {
  /** @type {Record<string, string>} */
  const state = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return state;
  }
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!VNC_KEYS.includes(key)) continue;
    const value = line.slice(at + 1).trim();
    // Quoted values are how a shell would write a path with a space in it.
    state[key] = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return state;
}

/**
 * The display environment for an owner shell: only the variables that are
 * actually known, so an env passed to `pty.spawn` never carries an empty
 * `DISPLAY` that some client would treat as a working setting.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   stateFile?: string,
 * }} [options]
 * @returns {{
 *   DISPLAY?: string,
 *   WAYLAND_DISPLAY?: string,
 *   XAUTHORITY?: string,
 *   XDG_RUNTIME_DIR?: string,
 * }}
 */
export function terminalDisplayEnv(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME || os.homedir() || "";
  const stateFile = options.stateFile ?? (home ? vncStatePath(home) : "");
  const state = stateFile ? readVncState(stateFile) : {};

  /**
   * @type {{
   *   DISPLAY?: string,
   *   WAYLAND_DISPLAY?: string,
   *   XAUTHORITY?: string,
   *   XDG_RUNTIME_DIR?: string,
   * }}
   */
  const display = {};

  const fromEnv = (env.DISPLAY ?? "").trim();
  const fromState = (state.CLAWBOX_VNC_DISPLAY ?? "").trim();
  // A DISPLAY from our own environment is taken as-is; the one from the state
  // file has to look like a display before it goes anywhere.
  const useState = !fromEnv && DISPLAY_RE.test(fromState);
  if (fromEnv) display.DISPLAY = fromEnv;
  else if (useState) display.DISPLAY = fromState;

  const wayland = (env.WAYLAND_DISPLAY ?? "").trim();
  if (wayland) {
    display.WAYLAND_DISPLAY = wayland;
    // A relative WAYLAND_DISPLAY names a socket inside XDG_RUNTIME_DIR, so the
    // child needs that directory to find it — defaulting to /run/user/<uid>
    // is wrong whenever the owner's session runs elsewhere. An absolute one
    // names the socket itself and needs nothing added.
    const runtimeDir = (env.XDG_RUNTIME_DIR ?? "").trim();
    if (!path.isAbsolute(wayland) && runtimeDir) display.XDG_RUNTIME_DIR = runtimeDir;
  }

  // The recorded authority is the cookie for the recorded display. Handing it
  // to an inherited display would point the owner's session at another
  // server's cookie, so it is used only when the recorded display is the one
  // selected; otherwise XAUTHORITY stays unset unless our env has its own.
  const authority =
    (env.XAUTHORITY ?? "").trim() || (useState ? (state.CLAWBOX_VNC_XAUTHORITY ?? "").trim() : "");
  if (authority) display.XAUTHORITY = authority;

  return display;
}
