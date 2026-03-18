export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const exec = promisify(execFile);
const CLAWBOX_USER = process.env.SUDO_USER || process.env.USER || "clawbox";
const HOME = CLAWBOX_USER === "root" ? "/home/clawbox" : `/home/${CLAWBOX_USER}`;
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, "openclaw.json");

// Find openclaw binary
function findOpenClaw(): string {
  const existsSync = require("fs").existsSync;
  const nodeDir = path.dirname(process.execPath);
  const npmGlobal = path.join(HOME, ".npm-global", "bin", "openclaw");
  const candidates = [
    path.join(nodeDir, "openclaw"),
    npmGlobal,
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  const nvmDir = path.join(HOME, ".nvm", "versions", "node");
  try {
    const versions = require("fs").readdirSync(nvmDir) as string[];
    for (const v of versions.sort().reverse()) {
      candidates.push(path.join(nvmDir, v, "bin", "openclaw"));
    }
  } catch {}
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "openclaw";
}

// Check if Chromium is installed
async function checkChromium(): Promise<{ installed: boolean; path?: string; version?: string }> {
  const candidates = ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"];
  for (const bin of candidates) {
    try {
      const { stdout } = await exec("which", [bin], { timeout: 5000 });
      const chromPath = stdout.trim();
      if (chromPath) {
        try {
          const { stdout: ver } = await exec(chromPath, ["--version"], { timeout: 5000 });
          return { installed: true, path: chromPath, version: ver.trim() };
        } catch {
          return { installed: true, path: chromPath };
        }
      }
    } catch {}
  }
  // Check snap chromium
  try {
    const { stdout } = await exec("snap", ["list", "chromium"], { timeout: 5000 });
    if (stdout.includes("chromium")) {
      return { installed: true, path: "/snap/bin/chromium", version: stdout.split("\n")[1]?.trim() };
    }
  } catch {}
  return { installed: false };
}

// Check if browser is currently running
async function isBrowserRunning(): Promise<{ running: boolean; pid?: number }> {
  try {
    const { stdout } = await exec("pgrep", ["-f", "chrom.*--user-data-dir.*clawbox-browser"], { timeout: 5000 });
    const pids = stdout.trim().split("\n").map(s => parseInt(s)).filter(n => !isNaN(n) && n > 0);
    if (pids.length > 0) return { running: true, pid: pids[0] };
  } catch {}
  return { running: false };
}

// Read OpenClaw config
async function readOpenClawConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}


export async function GET() {
  try {
    const [chromium, browser, config] = await Promise.all([
      checkChromium(),
      isBrowserRunning(),
      readOpenClawConfig(),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const computerUse = (config as any)?.agents?.defaults?.tools?.computer_use;
    const enabled = !!computerUse?.enabled;

    return NextResponse.json({
      chromium,
      browser,
      enabled,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Status check failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { action } = await req.json();

    switch (action) {
      case "install-chromium": {
        // Try apt first, then snap
        try {
          await exec("sudo", ["apt-get", "update", "-qq"], { timeout: 30000 });
          await exec("sudo", ["apt-get", "install", "-y", "-qq", "chromium-browser"], { timeout: 120000 });
        } catch {
          try {
            await exec("sudo", ["snap", "install", "chromium"], { timeout: 120000 });
          } catch (snapErr) {
            // Try chromium package name (Debian/Ubuntu variations)
            try {
              await exec("sudo", ["apt-get", "install", "-y", "-qq", "chromium"], { timeout: 120000 });
            } catch {
              throw new Error(`Failed to install Chromium: ${snapErr instanceof Error ? snapErr.message : "unknown error"}`);
            }
          }
        }
        const status = await checkChromium();
        return NextResponse.json({ ok: true, chromium: status });
      }

      case "enable": {
        // Configure OpenClaw with computer-use browser settings
        const chromium = await checkChromium();
        if (!chromium.installed) {
          return NextResponse.json({ error: "Chromium not installed" }, { status: 400 });
        }

        const profileDir = path.join(HOME, ".config", "clawbox-browser");
        await fs.mkdir(profileDir, { recursive: true });

        // Enable computer_use via CLI (avoids writing unrecognized keys to config)
        const openclawBin = findOpenClaw();
        try {
          await exec(openclawBin, [
            "config", "set", "agents.defaults.tools.computer_use.enabled", "true", "--json",
          ], { timeout: 10000 });
        } catch {}

        return NextResponse.json({ ok: true, enabled: true, profileDir });
      }

      case "disable": {
        const openclawBin = findOpenClaw();
        try {
          await exec(openclawBin, [
            "config", "set", "agents.defaults.tools.computer_use.enabled", "false", "--json",
          ], { timeout: 10000 });
        } catch {}
        return NextResponse.json({ ok: true, enabled: false });
      }

      case "open-browser": {
        const chromium = await checkChromium();
        if (!chromium.installed || !chromium.path) {
          return NextResponse.json({ error: "Chromium not installed" }, { status: 400 });
        }

        // Check if already running
        const running = await isBrowserRunning();
        if (running.running) {
          return NextResponse.json({ ok: true, alreadyRunning: true, pid: running.pid });
        }

        const profileDir = path.join(HOME, ".config", "clawbox-browser");
        await fs.mkdir(profileDir, { recursive: true });

        // Detect active X display dynamically
        let display = process.env.DISPLAY || ":0";
        try {
          const { stdout: xdpy } = await exec("bash", ["-c",
            "for d in 1 0 2; do if DISPLAY=\":$d\" xdpyinfo >/dev/null 2>&1; then echo \":$d\"; exit; fi; done; echo ':0'"
          ], { timeout: 3000 });
          display = xdpy.trim();
        } catch {}

        // Launch browser
        const isRoot = process.getuid?.() === 0;
        const args = [
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--start-maximized",
          "--disable-gpu",
          "--disable-gpu-compositing",
          "--disable-gpu-sandbox",
          "--enable-features=UseOzonePlatform",
          "--ozone-platform=x11",
          "--in-process-gpu",
          ...(isRoot ? ["--no-sandbox"] : []),
          "https://www.google.com",
        ];

        try {
          // Find Xauthority for the display
          let xauth = "/run/user/1000/gdm/Xauthority";
          try {
            const { stdout: xa } = await exec("bash", ["-c",
              "ps aux | grep '[X]org' | grep -oP '\\-auth \\K\\S+' | head -1"
            ], { timeout: 3000 });
            if (xa.trim()) xauth = xa.trim();
          } catch {}

          // Launch browser with correct DISPLAY and XAUTHORITY
          // Use bash -c so the snap wrapper script works correctly
          const launchCmd = `${chromium.path} ${args.map(a => `'${a}'`).join(" ")}`;
          console.log(`[browser] Launching: bash -c ${launchCmd}`);
          console.log(`[browser] DISPLAY=${display} XAUTHORITY=${xauth} USER=${CLAWBOX_USER}`);
          const child = require("child_process").spawn("bash", ["-c", launchCmd], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              DISPLAY: display,
              XAUTHORITY: xauth,
              DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
              HOME,
            },
          });

          child.stderr?.on("data", (d: Buffer) => {
            console.error(`[browser-stderr] ${d.toString().trim()}`);
          });
          child.on("exit", (code: number) => {
            console.log(`[browser] Process exited with code ${code}`);
          });
          child.unref();

          // Wait briefly and check if it started
          await new Promise(r => setTimeout(r, 3000));
          const status = await isBrowserRunning();
          const ok = status.running;
          if (!ok) {
            return NextResponse.json({ error: "Browser process exited immediately. Check server logs." }, { status: 500 });
          }
          return NextResponse.json({ ok: true, pid: status.pid || child.pid });
        } catch (err) {
          return NextResponse.json({ error: `Failed to launch browser: ${err instanceof Error ? err.message : "unknown"}` }, { status: 500 });
        }
      }

      case "close-browser": {
        const running = await isBrowserRunning();
        if (!running.running || !running.pid) {
          return NextResponse.json({ ok: true, wasRunning: false });
        }
        try {
          await exec("pkill", ["-f", "chrom.*--user-data-dir.*clawbox-browser"], { timeout: 5000 });
        } catch {}
        // Wait for processes to die, then clean up stale lock files
        // so the next launch doesn't think an instance is already running
        await new Promise(r => setTimeout(r, 1000));
        const profileDir = path.join(HOME, ".config", "clawbox-browser");
        await Promise.all(
          ["SingletonLock", "SingletonSocket", "SingletonCookie"].map(f =>
            fs.unlink(path.join(profileDir, f)).catch(() => {})
          )
        );
        return NextResponse.json({ ok: true, wasRunning: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
  }
}
