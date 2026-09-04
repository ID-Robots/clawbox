/**
 * What the owner DECIDES about the desktop browser: whether they have been
 * through its front door, whether opening the app opens Chromium, and where a
 * freshly started Chromium lands.
 *
 * All three live in data/config.json beside the coding agent's, ClawKeep's and
 * Memory Shard's flags — not in the sqlite store, which on this box only ever
 * held the OpenClaw integration switch and falls back to the same JSON file
 * under a prefixed key anyway.
 *
 * The start page is the one setting here that has to reach outside the web
 * server: Chromium is started by systemd, not by us, so the value is handed to
 * scripts/launch-browser.sh through ~/.cache/clawbox/browser.env — the same
 * mechanism start-vnc.sh already uses to tell that script which display to use.
 */

import fs from "fs/promises";
import path from "path";
import { get as configGet, set as configSet } from "@/lib/config-store";

export const BROWSER_SETUP_CONFIG_KEY = "browser_setup_complete";
export const BROWSER_AUTO_OPEN_CONFIG_KEY = "browser_auto_open";
export const BROWSER_START_URL_CONFIG_KEY = "browser_start_url";

/** What Chromium opens with when the owner has not chosen anything — the same
 *  address scripts/launch-browser.sh falls back to, so the two agree. */
export const DEFAULT_START_URL = "https://www.google.com";

const CLAWBOX_USER = process.env.SUDO_USER || process.env.USER || "clawbox";
const HOME = CLAWBOX_USER === "root" ? "/home/clawbox" : `/home/${CLAWBOX_USER}`;
/** Read by scripts/launch-browser.sh, next to the VNC display it already reads. */
export const BROWSER_ENV_FILE = path.join(HOME, ".cache", "clawbox", "browser.env");

/**
 * Has the owner been through the wizard?
 *
 * The explicit flag wins, for the reason Memory Shard's does: the wizard
 * switches things on as it goes, and a rule of `flag || working` would declare
 * setup finished at the step that installs Chromium and swap the last step for
 * the browser screen. Without a flag, a box whose browser was already linked
 * and installed has been set up by definition and must not be dragged through
 * onboarding by an update.
 *
 * `working` is the caller's fact, not a second probe: the manage route has
 * already asked whether Chromium is there and whether the link is on.
 */
export async function getBrowserSetupComplete(working: boolean): Promise<boolean> {
  const flag = await configGet(BROWSER_SETUP_CONFIG_KEY);
  if (typeof flag === "boolean") return flag;
  return working;
}

/** The stored flag as it is, `null` when the owner has never been asked —
 *  what the setup route answers with, since it has none of the facts the
 *  fallback above needs. */
export async function readBrowserSetupFlag(): Promise<boolean | null> {
  const flag = await configGet(BROWSER_SETUP_CONFIG_KEY);
  return typeof flag === "boolean" ? flag : null;
}

export async function setBrowserSetupComplete(done: boolean): Promise<boolean> {
  await configSet(BROWSER_SETUP_CONFIG_KEY, done);
  return done;
}

/** On unless the owner said otherwise: the app is the browser, and an app that
 *  shows a dead screen until you find a button is the thing this replaced. */
export async function getBrowserAutoOpen(): Promise<boolean> {
  return (await configGet(BROWSER_AUTO_OPEN_CONFIG_KEY)) !== false;
}

export async function setBrowserAutoOpen(enabled: boolean): Promise<boolean> {
  await configSet(BROWSER_AUTO_OPEN_CONFIG_KEY, enabled);
  return enabled;
}

/**
 * The owner's start page as a URL that is safe to hand to a shell.
 *
 * http(s) only — Chromium would happily open `file:///etc/shadow` on the
 * screen the agent can screenshot — and the serialized form is what gets
 * stored, so a stored value can never be a half-typed address. The single
 * quote is percent-encoded because the value is written into a
 * single-quoted shell assignment, which nothing else can escape.
 */
export function normalizeStartUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/'/g, "%27");
}

export async function getBrowserStartUrl(): Promise<string> {
  return normalizeStartUrl(await configGet(BROWSER_START_URL_CONFIG_KEY)) ?? DEFAULT_START_URL;
}

/** `null` puts the default back rather than storing an empty address. */
export async function setBrowserStartUrl(url: string | null): Promise<string> {
  const next = url === null ? null : normalizeStartUrl(url);
  await configSet(BROWSER_START_URL_CONFIG_KEY, next ?? undefined);
  return next ?? DEFAULT_START_URL;
}

/**
 * Hand the start page to the launch script.
 *
 * Best-effort on purpose: a browser that opens on Google instead of the
 * owner's start page is a smaller failure than a browser that refuses to
 * open, so a write that fails is logged and the launch goes ahead.
 */
export async function writeBrowserLaunchEnv(startUrl: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(BROWSER_ENV_FILE), { recursive: true });
    await fs.writeFile(
      BROWSER_ENV_FILE,
      `# Written by ClawBox — Settings → Browser. Read by scripts/launch-browser.sh.\nCLAWBOX_BROWSER_START_URL='${startUrl}'\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    console.warn("[browser] could not write the launch environment:", err instanceof Error ? err.message : err);
  }
}
