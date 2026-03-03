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

    // 4. Delete saved WiFi connections so device returns to AP mode after reboot
    await deleteWifiConnections().catch((err) => {
      console.error("[Reset] WiFi cleanup failed:", err instanceof Error ? err.message : err);
    });

    // 5. Return error if file cleanup had failures
    if (allFailures.length > 0) {
      return NextResponse.json(
        { error: `Factory reset incomplete: ${allFailures.length} file deletion(s) failed`, failures: allFailures },
        { status: 500 },
      );
    }

    // 6. Schedule a full system reboot (short delay so the response reaches the client)
    setTimeout(async () => {
      try {
        await execFile("systemctl", ["reboot"], { timeout: 10_000 });
      } catch (err) {
        console.error("[Reset] Reboot failed:", err instanceof Error ? err.message : err);
      }
    }, 1_000);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Factory reset failed" },
      { status: 500 },
    );
  }
}
