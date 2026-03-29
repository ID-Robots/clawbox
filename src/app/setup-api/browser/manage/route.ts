export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { readConfig } from "@/lib/openclaw-config";

const exec = promisify(execFile);
const CLAWBOX_USER = process.env.SUDO_USER || process.env.USER || "clawbox";
const HOME = CLAWBOX_USER === "root" ? "/home/clawbox" : `/home/${CLAWBOX_USER}`;
const PROFILE_DIR = path.join(HOME, ".config", "clawbox-browser");
const CDP_PORT = 18800;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOpenClaw(): Promise<string> {
  const candidates = [
    path.join(HOME, ".npm-global", "bin", "openclaw"),
    path.join(path.dirname(process.execPath), "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch {}
  }
  return "openclaw";
}

async function checkChromium(): Promise<{ installed: boolean; path?: string; version?: string }> {
  // Check all candidates in parallel
  const candidates = ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"];
  const results = await Promise.all(candidates.map(async (bin) => {
    try {
      const { stdout } = await exec("which", [bin], { timeout: 3000 });
      return stdout.trim() || null;
    } catch { return null; }
  }));
  const found = results.find(p => p);
  if (found) {
    try {
      const { stdout: ver } = await exec(found, ["--version"], { timeout: 3000 });
      return { installed: true, path: found, version: ver.trim() };
    } catch {
      return { installed: true, path: found };
    }
  }
  // Check snap
  try {
    const { stdout } = await exec("snap", ["list", "chromium"], { timeout: 3000 });
    if (stdout.includes("chromium")) {
      return { installed: true, path: "/snap/bin/chromium", version: stdout.split("\n")[1]?.trim() };
    }
  } catch {}
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
async function getBrowserStatus(): Promise<{ running: boolean; pid?: number; cdpReady: boolean }> {
  // Check CDP endpoint first (most reliable)
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      // Find the main process PID
      try {
        const { stdout } = await exec("pgrep", ["-f", `remote-debugging-port=${CDP_PORT}`], { timeout: 3000 });
        const pid = parseInt(stdout.trim().split("\n")[0]);
        return { running: true, pid: isNaN(pid) ? undefined : pid, cdpReady: true };
      } catch {
        return { running: true, cdpReady: true };
      }
    }
  } catch {}
  // Fallback: check process
  try {
    const { stdout } = await exec("pgrep", ["-f", "chrom.*--user-data-dir.*clawbox-browser"], { timeout: 3000 });
    const pids = stdout.trim().split("\n").map(s => parseInt(s)).filter(n => !isNaN(n) && n > 0);
    if (pids.length > 0) return { running: true, pid: pids[0], cdpReady: false };
  } catch {}
  return { running: false, cdpReady: false };
}

const readOpenClawConfig = readConfig;

// ─── GET — status ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const [chromium, browser, config] = await Promise.all([
      checkChromium(),
      getBrowserStatus(),
      readOpenClawConfig(),
    ]);

    const enabled = config.tools?.profile === "full";

    return NextResponse.json({
      chromium,
      browser,
      enabled,
      cdpPort: CDP_PORT,
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
        try {
          await exec("sudo", ["apt-get", "update", "-qq"], { timeout: 30000 });
          await exec("sudo", ["apt-get", "install", "-y", "-qq", "chromium-browser"], { timeout: 120000 });
        } catch {
          try {
            await exec("sudo", ["snap", "install", "chromium"], { timeout: 120000 });
          } catch (snapErr) {
            try {
              await exec("sudo", ["apt-get", "install", "-y", "-qq", "chromium"], { timeout: 120000 });
            } catch {
              throw new Error(`Failed to install Chromium: ${snapErr instanceof Error ? snapErr.message : "unknown error"}`);
            }
          }
        }
        return NextResponse.json({ ok: true, chromium: await checkChromium() });
      }

      case "enable": {
        const chromium = await checkChromium();
        if (!chromium.installed) {
          return NextResponse.json({ error: "Chromium not installed" }, { status: 400 });
        }

        await fs.mkdir(PROFILE_DIR, { recursive: true });

        const openclawBin = await findOpenClaw();
        try {
          await Promise.all([
            exec(openclawBin, ["config", "set", "tools.profile", "full"], { timeout: 10000 }),
            exec(openclawBin, ["config", "set", "tools.web.search.enabled", "true", "--json"], { timeout: 10000 }),
          ]);
        } catch (err) {
          console.error("[browser] Failed to set tools config:", err);
        }

        let enableRestartOk = true;
        try {
          await exec("sudo", ["systemctl", "restart", "clawbox-gateway"], { timeout: 15000 });
        } catch (err) {
          console.error("[browser] Gateway restart failed:", err);
          enableRestartOk = false;
        }

        return NextResponse.json({ ok: true, enabled: true, profileDir: PROFILE_DIR, gatewayRestarted: enableRestartOk });
      }

      case "disable": {
        const openclawBin = await findOpenClaw();
        try {
          await exec(openclawBin, ["config", "set", "tools.profile", "coding"], { timeout: 10000 });
        } catch (err) {
          console.error("[browser] Failed to unset tools config:", err);
        }

        let disableRestartOk = true;
        try {
          await exec("sudo", ["systemctl", "restart", "clawbox-gateway"], { timeout: 15000 });
        } catch (err) {
          console.error("[browser] Gateway restart failed:", err);
          disableRestartOk = false;
        }

        return NextResponse.json({ ok: true, enabled: false, gatewayRestarted: disableRestartOk });
      }

      case "open-browser": {
        // Check if already running via CDP
        const existing = await getBrowserStatus();
        if (existing.cdpReady) {
          return NextResponse.json({ ok: true, alreadyRunning: true, pid: existing.pid, cdpPort: CDP_PORT });
        }

        const chromium = await checkChromium();
        if (!chromium.installed || !chromium.path) {
          return NextResponse.json({ error: "Chromium not installed" }, { status: 400 });
        }

        await fs.mkdir(PROFILE_DIR, { recursive: true });

        await cleanBrowserLocks();

        try {
          console.log(`[browser] Starting clawbox-browser.service (CDP port ${CDP_PORT})`);
          // Start dedicated service — runs as root, drops to clawbox via runuser
          await exec("sudo", [
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
          await exec("sudo", ["/usr/bin/systemctl", "stop", "clawbox-browser.service"], { timeout: 10000 });
        } catch {}
        try {
          await exec("pkill", ["-f", "chrom.*--user-data-dir.*clawbox-browser"], { timeout: 5000 });
        } catch {}
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
