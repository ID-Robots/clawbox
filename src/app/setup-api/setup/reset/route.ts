import { NextResponse } from "next/server";
import { resetUpdateState } from "@/lib/updater";
import { DATA_DIR } from "@/lib/config-store";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";
const OPENCLAW_DIR = "/home/clawbox/.openclaw";

// Files to preserve during factory reset (hardware-specific, auto-generated)
const PRESERVE_FILES = new Set(["network.env"]);

/** Delete all Ollama models so a factory reset starts with a clean slate. */
async function deleteOllamaModels(): Promise<void> {
  const OLLAMA = "http://127.0.0.1:11434";
  let models: { name: string }[];
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return;
    const data = await res.json();
    models = data.models ?? [];
  } catch {
    // Ollama not running — nothing to clean
    return;
  }
  for (const { name } of models) {
    try {
      await fetch(`${OLLAMA}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[Reset] Deleted Ollama model: ${name}`);
    } catch (err) {
      console.warn(`[Reset] Failed to delete Ollama model '${name}':`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Delete all saved WiFi connections from NetworkManager.
 * Without this, the device auto-reconnects to a saved network after reboot
 * instead of returning to AP (captive portal) mode.
 */
async function deleteWifiConnections(): Promise<void> {
  const { stdout } = await execFile("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"], {
    timeout: 10_000,
  });
  const wifiNames = stdout
    .trim()
    .split("\n")
    .filter((line) => line.endsWith(":802-11-wireless"))
    .map((line) => line.slice(0, -":802-11-wireless".length));

  for (const name of wifiNames) {
    await execFile("nmcli", ["connection", "delete", name], { timeout: 10_000 }).catch((err) => {
      console.warn(`[Reset] Failed to delete WiFi connection '${name}':`, err instanceof Error ? err.message : err);
    });
  }
  if (wifiNames.length > 0) {
    console.log(`[Reset] Deleted ${wifiNames.length} saved WiFi connection(s)`);
  }
}

async function removeDirectoryContents(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  const results = await Promise.allSettled(
    entries.map(entry => fs.rm(path.join(dir, entry), { recursive: true, force: true }))
  );
  const failures = results
    .map((r, i) => r.status === "rejected" ? `${entries[i]}: ${r.reason}` : null)
    .filter((f): f is string => f !== null);
  if (failures.length > 0) {
    console.warn(`[Reset] Failed to remove ${failures.length} item(s) in ${dir}:`, failures);
  }
  return failures;
}


export async function POST() {
  try {
    // 1. Reset in-memory update state
    resetUpdateState();

    // 2. Wipe data directory (config.json, OAuth state, etc.) — preserve hardware-specific files
    const dataFailures: string[] = [];
    try {
      const entries = await fs.readdir(DATA_DIR);
      const results = await Promise.allSettled(
        entries
          .filter(entry => !PRESERVE_FILES.has(entry))
          .map(entry => fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true }))
      );
      for (const r of results) {
        if (r.status === "rejected") dataFailures.push(String(r.reason));
      }
    } catch (err: unknown) {
      if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) throw err;
    }

    // 3. Wipe entire OpenClaw directory (config, agents, sessions, credentials, logs, workspace)
    const openclawFailures = await removeDirectoryContents(OPENCLAW_DIR);
    const allFailures = [...dataFailures, ...openclawFailures];
    if (allFailures.length > 0) {
      console.warn(`[Reset] ${allFailures.length} file deletion(s) failed — continuing with reboot`);
    }

    // 4. Seed minimal openclaw.json with token-based gateway auth
    // (gateway.auth.mode="token", token="clawbox") so the gateway can still
    // bind on LAN after reboot. This is a predictable recovery token; keep it
    // only as a short-lived recovery default and replace it during setup.
    try {
      await fs.mkdir(OPENCLAW_DIR, { recursive: true });
      const seed = {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 24000,
            },
          },
        },
        gateway: {
          auth: { mode: "token", token: "clawbox" },
          controlUi: {
            allowInsecureAuth: true,
            dangerouslyDisableDeviceAuth: true,
          },
        },
      };
      await fs.writeFile(
        path.join(OPENCLAW_DIR, "openclaw.json"),
        JSON.stringify(seed, null, 2),
        { mode: 0o600 },
      );
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      await fs.chown(path.join(OPENCLAW_DIR, "openclaw.json"), uid, gid);
      console.log("[Reset] Seeded openclaw.json with token auth");
    } catch (err) {
      console.warn("[Reset] Failed to seed openclaw.json:", err instanceof Error ? err.message : err);
    }

    // 5. Delete all Ollama models
    await deleteOllamaModels().catch((err) => {
      console.error("[Reset] Ollama cleanup failed:", err instanceof Error ? err.message : err);
    });

    // 6. Delete saved WiFi connections so device returns to AP mode after reboot
    await deleteWifiConnections().catch((err) => {
      console.error("[Reset] WiFi cleanup failed:", err instanceof Error ? err.message : err);
    });

    // 7. Return error if file cleanup had failures
    if (allFailures.length > 0) {
      return NextResponse.json(
        { error: `Factory reset incomplete: ${allFailures.length} file deletion(s) failed`, failures: allFailures },
        { status: 500 },
      );
    }

    // 8. Schedule a full system reboot (short delay so the response reaches the client)
    setTimeout(async () => {
      try {
        await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reboot"], { timeout: 10_000 });
      } catch (err) {
        console.error("[Reset] Reboot failed:", err instanceof Error ? err.message : err);
      }
    }, 1_000);

    const response = NextResponse.json({ success: true });
    response.cookies.set("clawbox_session", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
      secure: false,
    });
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Factory reset failed" },
      { status: 500 },
    );
  }
}
