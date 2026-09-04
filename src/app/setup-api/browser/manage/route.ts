export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { constants as fsConstants } from "fs";
import fs from "fs/promises";
import path from "path";
import type { OpenClawConfig } from "@/lib/openclaw-config";
import { openclawIsAbsent, readConfig, restartGateway, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import { findClawboxBrowserPids, terminateClawboxBrowser, terminateForeignCdpBrowser } from "@/lib/process-match";
import { findPlaywrightChromium } from "@/lib/cdp-probe";
import {
  getBrowserAutoOpen,
  getBrowserSetupComplete,
  getBrowserStartUrl,
  writeBrowserLaunchEnv,
} from "@/lib/browser-setup";

const exec = promisify(execFile);
const CLAWBOX_USER = process.env.SUDO_USER || process.env.USER || "clawbox";
const HOME = CLAWBOX_USER === "root" ? "/home/clawbox" : `/home/${CLAWBOX_USER}`;
const PROFILE_DIR = path.join(HOME, ".config", "clawbox-browser");
const PLAYWRIGHT_BROWSERS_DIR = path.join(HOME, ".cache", "ms-playwright");
const CDP_PORT = 18800;
const BROWSER_ENABLED_KEY = "browser:integration-enabled";

/**
 * Is the browser↔agent link a switch the owner flips, or is it simply always on?
 *
 * On OpenClaw it is a switch. "Enable" writes `tools.profile: full` and
 * `tools.web.search.enabled: true` into ~/.openclaw/openclaw.json and bounces
 * the gateway, because the agent ships with a restricted `coding` tool profile
 * that has no browsing in it.
 *
 * On Hermes there is no switch, because there is nothing to switch. The four
 * ClawBox browser tools (browser_open / browser_navigate / browser_screenshot /
 * browser_close in mcp/tools/browser.ts) are registered on this edition
 * unconditionally, scripts/register-mcp.sh wires the ClawBox MCP server into
 * ~/.hermes/config.yaml at every web-server boot, and that same script turns the
 * harness's own browser toolset off so browsing goes through those tools and
 * therefore through the Chromium window on the desktop. Hermes has no
 * `tools.profile` to flip and no separate web-search tool to arm.
 *
 * So the panel previously offered an Activate button here that could only ever
 * fail: the action reached for the `openclaw` CLI, which this edition does not
 * ship, and the owner got "The OpenClaw CLI is not available on this edition."
 * for a capability that was already working. `alwaysOn` is how the route tells
 * the client which of the two worlds it is in, so the panel can state the truth
 * instead of offering a switch.
 *
 * Keyed on the EDITION, not the active harness: a `dual` box still has the
 * OpenClaw CLI and its gateway, so it keeps the switch exactly as before.
 */
function integrationIsAlwaysOn(): boolean {
  return openclawIsAbsent();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function installPlaywrightChromium(): Promise<void> {
  const playwrightBin = path.join(process.cwd(), "node_modules", ".bin", "playwright");
  await fs.access(playwrightBin, fsConstants.X_OK);
  await exec(playwrightBin, ["install", "chromium"], {
    timeout: 300000,
    env: {
      ...process.env,
      HOME,
      PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS_DIR,
    },
  });
}

interface ChromiumInfo {
  installed: boolean;
  path?: string;
  version?: string;
  /**
   * Whether clawbox-browser.service could actually start this binary — see
   * isServiceSafeChromium(). Absent when nothing is installed.
   */
  serviceSafe?: boolean;
}

/**
 * Can a SYSTEM SERVICE start this binary?
 *
 * scripts/launch-browser.sh refuses the snap wrapper, because snap's cgroup
 * confinement makes Chromium fail under systemd. So a device can report
 * Chromium as installed and still have clawbox-browser.service exit 1 the
 * moment the owner presses Open — which the panel used to discover as a 500
 * ten seconds later. This asks the script's own question before anything is
 * started.
 */
async function isServiceSafeChromium(bin: string): Promise<boolean> {
  if (bin.startsWith("/snap/")) return false;
  try {
    const info = await fs.stat(bin);
    // Only a wrapper SCRIPT is small enough to be worth reading; a real
    // Chromium is a hundred megabytes and cannot be a snap shim.
    if (info.size > 64 * 1024) return true;
    const text = await fs.readFile(bin, "utf-8");
    return !/\/snap\/bin\/chromium|snap run chromium/.test(text);
  } catch {
    // Unreadable says nothing about snap either way; let the launch script
    // have the last word rather than refuse a browser that may be fine.
    return true;
  }
}

/** One found binary, with its version if it will say and whether a service
 *  could start it. */
async function describeChromium(binPath: string, serviceSafe?: boolean): Promise<ChromiumInfo> {
  const safe = serviceSafe ?? await isServiceSafeChromium(binPath);
  try {
    const { stdout: ver } = await exec(binPath, ["--version"], { timeout: 5000 });
    return { installed: true, path: binPath, version: ver.trim(), serviceSafe: safe };
  } catch {
    return { installed: true, path: binPath, serviceSafe: safe };
  }
}

async function checkChromium(): Promise<ChromiumInfo> {
  // Full chrome only: this is the browser the owner will see in a window,
  // and a headless shell cannot open one.
  const playwrightChromium = findPlaywrightChromium(PLAYWRIGHT_BROWSERS_DIR, { preferHeadless: false });
  // The Playwright runtime is the build install.sh puts there precisely
  // because a service can start it, so it needs no snap test.
  if (playwrightChromium) return describeChromium(playwrightChromium, true);

  // Check known paths directly first (fast, no subprocess), then fall back to `which`
  const knownPaths = ["/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
  for (const p of knownPaths) {
    try {
      await fs.access(p, fsConstants.X_OK);
      return describeChromium(p);
    } catch {}
  }
  // Fallback: use `which` for non-standard installs
  const candidates = ["chromium-browser", "chromium", "google-chrome"];
  for (const bin of candidates) {
    try {
      const { stdout } = await exec("which", [bin], { timeout: 3000 });
      const found = stdout.trim();
      if (found) return describeChromium(found);
    } catch {}
  }
  return { installed: false };
}

async function cleanBrowserLocks() {
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map(f =>
      fs.unlink(path.join(PROFILE_DIR, f)).catch(() => {})
    )
  );
}

/** Check if browser is running and CDP is accessible */
async function getBrowserStatus(): Promise<{ running: boolean; pid?: number; cdpReady: boolean; agentBrowsing?: boolean }> {
  // Identify the browser by its executable + our profile dir, never by a
  // regex over whole command lines — see src/lib/process-match.ts. The
  // harness runs each chat turn as `hermes chat -q <user's message>`, so a
  // command-line pattern is matchable from a chat message.
  const browserMatch = { profileDir: PROFILE_DIR, cdpPort: CDP_PORT };

  let cdpReady = false;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    cdpReady = res.ok;
  } catch {}

  // "Running" means OUR desktop browser process exists — the one on the
  // clawbox-browser profile. The CDP port answering is NOT that proof: the
  // agent's own headless browser binds the same port whenever it browses
  // before the owner opens the desktop browser, and reporting that as a
  // running desktop browser (green tick, PID, Close button) was TASK-515.
  // findClawboxBrowserPids handles its own I/O failures and returns [].
  const pids = await findClawboxBrowserPids(browserMatch);
  if (pids.length > 0) return { running: true, pid: pids[0], cdpReady };
  if (cdpReady) return { running: false, cdpReady: true, agentBrowsing: true };
  return { running: false, cdpReady: false };
}

const readOpenClawConfig = readConfig;

async function getPersistedBrowserEnabled(): Promise<boolean | null> {
  try {
    const stored = await sqliteGet(BROWSER_ENABLED_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return null;
  } catch (err) {
    console.warn("[browser] Failed to read persisted browser state:", err);
    return null;
  }
}

async function persistBrowserEnabled(enabled: boolean): Promise<void> {
  await sqliteSet(BROWSER_ENABLED_KEY, enabled ? "true" : "false");
}

// ─── GET — status ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const alwaysOn = integrationIsAlwaysOn();

    // On an always-on edition neither of the last two reads means anything:
    // there is no ~/.openclaw/openclaw.json to hold a tools profile, and the
    // sqlite flag only ever recorded the OpenClaw switch. Skip them rather than
    // derive a "disabled" answer from files this edition does not keep.
    const [chromium, browser, config, persistedEnabled, autoOpen, startUrl] = await Promise.all([
      checkChromium(),
      getBrowserStatus(),
      alwaysOn ? Promise.resolve({} as OpenClawConfig) : readOpenClawConfig(),
      alwaysOn ? Promise.resolve(null) : getPersistedBrowserEnabled(),
      getBrowserAutoOpen(),
      getBrowserStartUrl(),
    ]);

    const enabled = alwaysOn || (persistedEnabled ?? (config.tools?.profile === "full"));

    return NextResponse.json({
      chromium,
      browser,
      enabled,
      alwaysOn,
      cdpPort: CDP_PORT,
      // The wizard's flag, and the two settings the app reads on the same
      // poll it already runs — one answer, so the face it shows and the state
      // it shows can never come from two different moments.
      setupComplete: await getBrowserSetupComplete(enabled && chromium.installed),
      autoOpen,
      startUrl,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Status check failed" }, { status: 500 });
  }
}

// ─── POST — actions ──────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const { action } = await req.json();

    switch (action) {
      case "install-chromium": {
        let installError: Error | null = null;
        try {
          // Recover from any interrupted dpkg state before apt. Non-fatal:
          // if recovery itself fails, the subsequent apt-get call will surface
          // the real error — log so the failure is diagnosable.
          await exec("/usr/bin/sudo", ["dpkg", "--configure", "-a"], { timeout: 60000 }).catch((err) => {
            console.warn("[browser/install-chromium] dpkg --configure -a recovery failed (continuing):", err instanceof Error ? err.message : err);
          });
          await exec("/usr/bin/sudo", ["apt-get", "update", "-qq"], { timeout: 30000 });
          await exec("/usr/bin/sudo", ["apt-get", "install", "-y", "-qq", "chromium-browser"], { timeout: 120000 });
        } catch {
          try {
            await exec("/usr/bin/sudo", ["snap", "install", "chromium"], { timeout: 120000 });
          } catch (snapErr) {
            try {
              await exec("/usr/bin/sudo", ["apt-get", "install", "-y", "-qq", "chromium"], { timeout: 120000 });
            } catch {
              installError = new Error(`Failed to install Chromium: ${snapErr instanceof Error ? snapErr.message : "unknown error"}`);
            }
          }
        }

        try {
          await installPlaywrightChromium();
        } catch (err) {
          if (installError) throw installError;
          console.warn("[browser] Playwright Chromium install failed:", err);
        }

        const chromium = await checkChromium();
        if (!chromium.installed) {
          throw installError ?? new Error("Chromium install finished but no browser binary was detected");
        }

        return NextResponse.json({ ok: true, chromium });
      }

      case "enable": {
        const chromium = await checkChromium();
        if (!chromium.installed) {
          return NextResponse.json({ error: "Chromium not installed", code: "chromium_not_installed" }, { status: 400 });
        }

        await fs.mkdir(PROFILE_DIR, { recursive: true });

        // Always-on edition: the profile dir above is the only preparation this
        // action can usefully do. Report the state as it already is instead of
        // reaching for a CLI that isn't installed here — see
        // integrationIsAlwaysOn(). The client hides the button on this edition;
        // this guard is what keeps a stale page or a direct call honest too.
        if (integrationIsAlwaysOn()) {
          return NextResponse.json({ ok: true, enabled: true, alwaysOn: true, profileDir: PROFILE_DIR });
        }

        try {
          await runOpenclawConfigSet(["tools.profile", "full"]);
          await runOpenclawConfigSet(["tools.web.search.enabled", "true", "--json"]);
          await persistBrowserEnabled(true);
        } catch (err) {
          console.error("[browser] Failed to set tools config:", err);
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to enable browser integration" },
            { status: 500 },
          );
        }

        let enableRestartOk = true;
        try {
          await restartGateway();
        } catch (err) {
          console.error("[browser] Gateway restart failed:", err);
          enableRestartOk = false;
        }

        return NextResponse.json({ ok: true, enabled: true, profileDir: PROFILE_DIR, gatewayRestarted: enableRestartOk });
      }

      case "disable": {
        // Nothing to take away on an always-on edition: the browser tools are
        // part of the tool set the harness is given at boot, not a stored
        // preference. Say so plainly rather than report a success that changed
        // nothing.
        if (integrationIsAlwaysOn()) {
          return NextResponse.json(
            {
              error: "Browser integration is built into this edition and cannot be turned off.",
              enabled: true,
              alwaysOn: true,
            },
            { status: 400 },
          );
        }

        try {
          await runOpenclawConfigSet(["tools.profile", "coding"]);
          await persistBrowserEnabled(false);
        } catch (err) {
          console.error("[browser] Failed to unset tools config:", err);
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to disable browser integration" },
            { status: 500 },
          );
        }

        let disableRestartOk = true;
        try {
          await restartGateway();
        } catch (err) {
          console.error("[browser] Gateway restart failed:", err);
          disableRestartOk = false;
        }

        return NextResponse.json({ ok: true, enabled: false, gatewayRestarted: disableRestartOk });
      }

      case "open-browser": {
        // Already running means OUR desktop browser answers — not merely that
        // something answers the CDP port (TASK-515: the agent's headless
        // browser satisfies a port probe, which made this button a no-op that
        // then reported success).
        const existing = await getBrowserStatus();
        if (existing.running && existing.cdpReady) {
          return NextResponse.json({ ok: true, alreadyRunning: true, pid: existing.pid, cdpPort: CDP_PORT });
        }

        const chromium = await checkChromium();
        if (!chromium.installed || !chromium.path) {
          return NextResponse.json({ error: "Chromium not installed", code: "chromium_not_installed" }, { status: 400 });
        }
        // Refuse in no time rather than start a service that exits 1 and
        // answer "Browser failed to start. Check /tmp/clawbox-browser.log"
        // ten seconds later — a true sentence that names the wrong remedy.
        if (chromium.serviceSafe === false) {
          return NextResponse.json(
            {
              error: "Only the snap build of Chromium is installed, and a system service cannot start it. Install the Playwright Chromium runtime.",
              code: "chromium_not_service_safe",
            },
            { status: 400 },
          );
        }

        // If the agent's headless browser holds the CDP port, the desktop
        // browser could start but never bind it — the two browsers would then
        // permanently diverge (separate profiles, separate logins). The owner
        // explicitly asked for a window, so close the headless one first; the
        // agent relaunches on demand and will attach to the desktop window,
        // which is the shared-browser state the panel describes.
        if (existing.agentBrowsing) {
          const cleared = await terminateForeignCdpBrowser({ profileDir: PROFILE_DIR, cdpPort: CDP_PORT });
          if (cleared > 0) console.log(`[browser] closed ${cleared} headless agent browser process(es) holding CDP :${CDP_PORT}`);
          // Wait for the port to actually free before launching against it. If
          // it never frees, fail honestly — starting the service anyway would
          // let the readiness probe mistake the foreign browser's answer for a
          // successful desktop launch, which is the exact lie this task removes.
          let portFree = false;
          for (let i = 0; i < 5; i++) {
            try {
              await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
              await new Promise(r => setTimeout(r, 1000));
            } catch { portFree = true; break; }
          }
          if (!portFree) {
            return NextResponse.json(
              { error: `The assistant's background browser is still holding CDP port ${CDP_PORT}. Try again in a moment.` },
              { status: 409 },
            );
          }
        }

        await fs.mkdir(PROFILE_DIR, { recursive: true });

        await cleanBrowserLocks();

        // systemd starts the browser, not us, so the owner's start page has to
        // be on disk before the unit runs — scripts/launch-browser.sh sources
        // this file the way it already sources the VNC display.
        await writeBrowserLaunchEnv(await getBrowserStartUrl());

        try {
          console.log(`[browser] Starting clawbox-browser.service (CDP port ${CDP_PORT})`);
          // Start dedicated service — runs as root, drops to clawbox via runuser
          await exec("/usr/bin/sudo", [
            "/usr/bin/systemctl", "start", "clawbox-browser.service",
          ], { timeout: 5000 }).catch((err) => {
            console.error("[browser] systemctl start failed:", err);
          });

          // Wait for CDP to become ready
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
              if (res.ok) {
                const version = await res.json();
                return NextResponse.json({
                  ok: true,
                  cdpPort: CDP_PORT,
                  cdpReady: true,
                  browser: version.Browser || version.product,
                });
              }
            } catch {}
          }

          // CDP didn't respond but process might be running
          const status = await getBrowserStatus();
          if (status.running) {
            return NextResponse.json({ ok: true, pid: status.pid, cdpPort: CDP_PORT, cdpReady: false });
          }
          return NextResponse.json({ error: "Browser failed to start. Check /tmp/clawbox-browser.log" }, { status: 500 });
        } catch (err) {
          return NextResponse.json({ error: `Failed to launch browser: ${err instanceof Error ? err.message : "unknown"}` }, { status: 500 });
        }
      }

      case "close-browser": {
        try {
          await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "stop", "clawbox-browser.service"], { timeout: 30000 });
        } catch (err) {
          // Non-fatal: the pkill + lock-cleanup fallback below still gets the
          // browser down. Log so ops can see if systemctl itself is wedged.
          console.warn("[browser] systemctl stop clawbox-browser.service failed:", err);
        }
        // Was `pkill -f "chrom.*--user-data-dir.*clawbox-browser"`. That matches
        // the regex against every process's full argv, and a chat turn runs as
        // `hermes chat -q <the user's message>` — so a message containing that
        // pattern made this call SIGTERM the turn answering it. Select by
        // executable + profile dir instead, which a message cannot forge.
        // Finding nothing is the happy path: the unit's KillMode=control-group
        // has usually already reaped the tree. Signal failures are swallowed by
        // terminateClawboxBrowser, so there is nothing here to catch.
        const signalled = await terminateClawboxBrowser({
          profileDir: PROFILE_DIR,
          cdpPort: CDP_PORT,
        });
        if (signalled > 0) {
          console.log(`[browser] terminated ${signalled} leftover browser process(es)`);
        }
        await new Promise(r => setTimeout(r, 1000));
        await cleanBrowserLocks();
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
  }
}
