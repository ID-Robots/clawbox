import { NextResponse } from "next/server";
import { resetUpdateState } from "@/lib/updater";
import { DATA_DIR } from "@/lib/config-store";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

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
 * Delete all saved WiFi connections from NetworkManager, including the
 * hotspot profile. Without this, the device auto-reconnects to a saved
 * network after reboot (bypassing AP/captive-portal mode), and the previous
 * hotspot password stays saved in the ClawBox-Setup profile.
 *
 * nmcli TYPE column varies by version ("wifi" modern, "802-11-wireless"
 * older) — match both.
 */
async function deleteWifiConnections(): Promise<void> {
  const { stdout } = await execFile("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"], {
    timeout: 10_000,
  });
  const wifiNames = new Set<string>();
  for (const line of stdout.trim().split("\n")) {
    const match = line.match(/^(.*):(?:wifi|802-11-wireless)$/);
    if (match) wifiNames.add(match[1]);
  }
  // Always attempt to delete the hotspot profile even if it didn't appear in
  // the listing, so a stored password from a renamed/stale connection can't
  // survive a factory reset.
  wifiNames.add("ClawBox-Setup");

  for (const name of wifiNames) {
    await execFile("nmcli", ["connection", "delete", name], { timeout: 10_000 }).catch((err) => {
      console.warn(`[Reset] Failed to delete WiFi connection '${name}':`, err instanceof Error ? err.message : err);
    });
  }
  if (wifiNames.size > 0) {
    console.log(`[Reset] Deleted ${wifiNames.size} WiFi connection(s) (including hotspot)`);
  }
}

async function removeDirectoryContents(dir: string): Promise<string[]> {
  // Background processes (npm install, plugin runtimes) can recreate files
  // between readdir and rm; one retry catches that.
  for (let attempt = 0; attempt < 2; attempt++) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
    if (entries.length === 0) return [];
    const results = await Promise.allSettled(
      entries.map(entry => fs.rm(path.join(dir, entry), { recursive: true, force: true }))
    );
    const failures = results
      .map((r, i) => r.status === "rejected" ? `${entries[i]}: ${r.reason}` : null)
      .filter((f): f is string => f !== null);
    if (failures.length === 0) return [];
    if (attempt === 0) {
      console.warn(`[Reset] ${failures.length} item(s) in ${dir} survived first pass — retrying:`, failures);
      continue;
    }
    console.warn(`[Reset] Failed to remove ${failures.length} item(s) in ${dir}:`, failures);
    return failures;
  }
  return [];
}


// Mask + stop is mandatory: with just `stop`, systemd's `Restart=always`
// auto-restarts the gateway within milliseconds, so the gateway then
// recreates plugin-runtime-deps mid-`fs.rm` and the wipe leaves stragglers.
// Mask blocks the auto-restart for the rest of this boot. Unmasked before
// reboot so the next boot brings the gateway back cleanly.
async function maskAndStopGateway(): Promise<void> {
  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "mask", "clawbox-gateway.service"], { timeout: 10_000 });
  } catch (err) {
    console.warn("[Reset] Failed to mask gateway:", err instanceof Error ? err.message : err);
  }
  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "stop", "clawbox-gateway.service"], { timeout: 15_000 });
  } catch (err) {
    console.warn("[Reset] Failed to stop gateway before wipe:", err instanceof Error ? err.message : err);
  }
}

async function unmaskGateway(): Promise<void> {
  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "unmask", "clawbox-gateway.service"], { timeout: 10_000 });
  } catch (err) {
    console.warn("[Reset] Failed to unmask gateway:", err instanceof Error ? err.message : err);
  }
}

function scheduleReboot(): void {
  setTimeout(async () => {
    try {
      await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reboot"], { timeout: 10_000 });
    } catch (err) {
      console.error("[Reset] Reboot failed:", err instanceof Error ? err.message : err);
    }
  }, 1_000);
}

export async function POST() {
  try {
    resetUpdateState();

    await maskAndStopGateway();

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

    const openclawFailures = await removeDirectoryContents(OPENCLAW_DIR);
    const allFailures = [...dataFailures, ...openclawFailures];

    // 4. Seed minimal openclaw.json with token-based gateway auth so the
    // gateway can still bind on LAN after reboot. The token is a freshly
    // generated 32-byte random hex per reset — earlier builds wrote the
    // literal "clawbox", which is public via the open-source repo and let
    // any LAN client connect straight to the gateway WS. The wizard reads
    // this back on the next configure save (`getOrGenerateGatewayToken`)
    // and reuses it.
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
          auth: { mode: "token", token: crypto.randomBytes(32).toString("hex") },
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

    // 6b. Reset mDNS hostname to "clawbox" (avahi + hostnamectl). Data dir is
    // already wiped, so clawbox-root-update@set_hostname.service will read the
    // default and apply it before the reboot.
    try {
      await execFile("/usr/bin/sudo", [
        "/usr/bin/systemctl",
        "start",
        "clawbox-root-update@set_hostname.service",
      ], { timeout: 10_000 });
    } catch (err) {
      console.warn("[Reset] Failed to reset hostname:", err instanceof Error ? err.message : err);
    }

    // Always unmask before either reboot or returning a failure — leaving the
    // unit masked would block the gateway from coming back on the next boot.
    await unmaskGateway();

    // Surface partial-wipe failures explicitly: returning an error here
    // (instead of rebooting silently) keeps the user on the reset screen so
    // they can retry or escalate. The masked-then-unmasked gateway is fine
    // either way; mask only persists until the next reboot.
    if (allFailures.length > 0) {
      console.warn(`[Reset] Aborting reboot — ${allFailures.length} wipe failure(s)`);
      return NextResponse.json(
        { error: `Factory reset incomplete: ${allFailures.length} file deletion(s) failed`, failures: allFailures },
        { status: 500 },
      );
    }

    scheduleReboot();

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
    await unmaskGateway();
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Factory reset failed" },
      { status: 500 },
    );
  }
}
