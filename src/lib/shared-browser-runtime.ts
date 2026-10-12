/**
 * The real readers and writers behind src/lib/shared-browser.ts, which takes
 * them as arguments so its decisions can be tested without a box. Loaded by
 * the boot hook (src/instrumentation.ts) and by the browser routes.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import { promisify } from "util";
import path from "./runtime-path";
import { findPlaywrightChromium } from "./cdp-probe";
import { getBrowserStartUrl, writeBrowserLaunchEnv } from "./browser-setup";
import { BROWSER_UNIT, readDesktopBrowserConfig, type DesktopBrowserConfig } from "./desktop-browser-config";
import { findCdpPortHolders, findClawboxBrowserPids, terminateClawboxBrowser, terminateForeignCdpBrowser } from "./process-match";
import { chromiumVersionOf, type KeeperDeps } from "./shared-browser";

const exec = promisify(execFile);

/**
 * Remove stale Chromium singleton locks so a new instance can start cleanly.
 *
 * On ClawBox's own profile every leftover lock is stale by the time this runs
 * (the caller has just established that no browser is up, or just stopped it).
 * On the OWNER's profile it does nothing while a browser is on it: there the
 * locks may be a live browser's of their own, and taking them away would let a
 * second browser open the same profile under it.
 */
export async function cleanBrowserLocks(config: DesktopBrowserConfig): Promise<void> {
  if (!config.ownProfile && (await findClawboxBrowserPids(config)).length > 0) return;
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((f) =>
      fs.unlink(path.join(config.profileDir, f)).catch(() => {}),
    ),
  );
}

/** Ask the unit to start the desktop browser. Rejects when systemd refuses. */
export async function startBrowserUnit(desktop: DesktopBrowserConfig): Promise<void> {
  await fs.mkdir(desktop.profileDir, { recursive: true });
  await cleanBrowserLocks(desktop);
  // systemd starts the browser, not us, so the owner's start page has to be on
  // disk before the unit runs — scripts/launch-browser.sh sources this file.
  await writeBrowserLaunchEnv(await getBrowserStartUrl());
  await exec("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "start", BROWSER_UNIT], { timeout: 15_000 });
}

/** What the keeper needs, wired to this box. */
export function sharedBrowserKeeperDeps(): KeeperDeps {
  return {
    readDesktop: () => readDesktopBrowserConfig(),
    findBrowserPids: (desktop) => findClawboxBrowserPids(desktop),
    findPortHolders: (desktop) => findCdpPortHolders(desktop),
    closeAssistantBrowser: (desktop) => terminateForeignCdpBrowser(desktop),
    startBrowser: startBrowserUnit,
  };
}

/** The version of the Chromium the unit would start for this configuration. */
export async function desktopBrowserVersion(desktop: DesktopBrowserConfig): Promise<string | null> {
  return chromiumVersionOf(desktop.executable ?? findPlaywrightChromium(undefined, { preferHeadless: false }));
}

/**
 * Close whatever browser is on `profileDir` and answer whether it went. Only
 * ever handed an assistant profile under the gateway's own directory, which
 * nobody but the gateway's hidden browser runs.
 */
export async function releaseBrowserProfile(profileDir: string, waitMs = 8_000): Promise<boolean> {
  const match = { profileDir, cdpPort: 0, ownProfile: true };
  if ((await findClawboxBrowserPids(match)).length === 0) return true;
  await terminateClawboxBrowser(match);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await findClawboxBrowserPids(match)).length === 0) return true;
  }
  return false;
}
