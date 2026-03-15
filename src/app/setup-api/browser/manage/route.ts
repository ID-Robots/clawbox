export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const exec = promisify(execFile);
const HOME = process.env.HOME || "/home/clawbox";
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
    const { stdout } = await exec("pgrep", ["-f", "chromium.*--user-data-dir.*clawbox-browser"], { timeout: 5000 });
    const pid = parseInt(stdout.trim().split("\n")[0]);
    if (pid) return { running: true, pid };
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

// Write OpenClaw config
async function writeOpenClawConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  const tmp = OPENCLAW_CONFIG + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmp, OPENCLAW_CONFIG);
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

        const config = await readOpenClawConfig();

        // Set up agents.defaults.tools.computer_use configuration
        if (!config.agents) config.agents = {};
        const agents = config.agents as Record<string, unknown>;
        if (!agents.defaults) agents.defaults = {};
        const defaults = agents.defaults as Record<string, unknown>;
        if (!defaults.tools) defaults.tools = {};
        const tools = defaults.tools as Record<string, unknown>;

        tools.computer_use = {
          enabled: true,
          browser: {
            command: chromium.path,
            args: [
              `--user-data-dir=${profileDir}`,
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-background-networking",
              "--start-maximized",
            ],
            profileDir,
          },
        };

        // Also configure the system prompt hint for browser use
        if (!defaults.systemPromptSuffix) {
          defaults.systemPromptSuffix = "";
        }
        const suffix = defaults.systemPromptSuffix as string;
        if (!suffix.includes("browser")) {
          defaults.systemPromptSuffix = (suffix ? suffix + "\n" : "") +
            "You have access to a real Chromium browser on the desktop. Use computer_use tool to interact with web pages. The browser uses a persistent profile at ~/.config/clawbox-browser/ so sessions and logins are preserved.";
        }

        await writeOpenClawConfig(config);

        // Also try to set via CLI if available
        const openclawBin = findOpenClaw();
        try {
          await exec(openclawBin, [
            "config", "set", "agents.defaults.tools.computer_use.enabled", "true", "--json",
          ], { timeout: 10000 });
        } catch {}

        return NextResponse.json({ ok: true, enabled: true, profileDir });
      }

      case "disable": {
        const config = await readOpenClawConfig();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tools = (config as any)?.agents?.defaults?.tools;
        if (tools?.computer_use) {
          tools.computer_use.enabled = false;
        }
        await writeOpenClawConfig(config);
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

        // Detect DISPLAY
        const display = process.env.DISPLAY || ":0";

        // Launch browser as the user (not root)
        const user = process.env.SUDO_USER || process.env.USER || "clawbox";
        const args = [
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--start-maximized",
          "https://www.google.com",
        ];

        try {
          // Try launching directly with DISPLAY set
          const child = require("child_process").spawn(chromium.path, args, {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, DISPLAY: display },
          });
          child.unref();

          // Wait briefly and check if it started
          await new Promise(r => setTimeout(r, 1500));
          const status = await isBrowserRunning();
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
          // Send SIGTERM to the process group
          await exec("pkill", ["-f", "chromium.*--user-data-dir.*clawbox-browser"], { timeout: 5000 });
        } catch {}
        return NextResponse.json({ ok: true, wasRunning: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed" }, { status: 500 });
  }
}
