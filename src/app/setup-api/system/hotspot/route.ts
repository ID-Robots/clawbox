import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { get, setMany, getAll } from "@/lib/config-store";
import { parseNmcliTerseLine } from "@/lib/network";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const HOTSPOT_ENV_PATH = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "hotspot.env"
);

let getCache: { body: unknown; at: number } | null = null;
const GET_TTL_MS = 3_000;

/**
 * What the save did to the access point, as one word.
 *
 *  * `restarted` — the AP was bounced, so this connection has just dropped.
 *  * `deferred`  — deliberately not bounced (the radio is a client right now);
 *                  the saved settings apply at the next AP start.
 *  * `stopped`   — the owner turned the hotspot off and it went down.
 *  * `failed`    — the toggle threw; the settings are saved, the radio is not
 *                  in the state the owner asked for, and `warning` says so.
 */
type HotspotApAction = "restarted" | "deferred" | "stopped" | "failed";

export async function GET() {
  if (getCache && Date.now() - getCache.at < GET_TTL_MS) {
    return NextResponse.json(getCache.body);
  }
  const config = await getAll();
  const ssid = (config.hotspot_ssid as string) || "ClawBox-Setup";
  const hasPassword = !!config.hotspot_password;
  const enabled = config.hotspot_enabled !== false;

  const iface = process.env.NETWORK_INTERFACE || "wlP1p1s0";
  let active = false;
  let blockedBy: string | null = null;
  try {
    const { stdout } = await execFileAsync("nmcli", [
      "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active",
    ], { timeout: 3_000 });
    const rows = stdout.split("\n").filter(Boolean).map(parseNmcliTerseLine);
    const apRow = rows.find(r => r[0] === "ClawBox-Setup" && r[2] === iface);
    active = !!apRow;
    if (enabled && !active) {
      const wifiRow = rows.find(r => r[1] === "802-11-wireless" && r[2] === iface && r[0] !== "ClawBox-Setup");
      if (wifiRow) blockedBy = wifiRow[0];
    }
  } catch (err) {
    console.warn("[hotspot] nmcli unavailable:", err);
  }

  const body = { ssid, hasPassword, enabled, active, blockedBy };
  getCache = { body, at: Date.now() };
  return NextResponse.json(body);
}

export async function POST(request: Request) {
  try {
    let body: { ssid?: string; password?: string; enabled?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { ssid, password, enabled } = body;

    if (!ssid || !ssid.trim()) {
      return NextResponse.json(
        { error: "Hotspot name is required" },
        { status: 400 }
      );
    }

    if (ssid.length > 32) {
      return NextResponse.json(
        { error: "Hotspot name must be 32 characters or less" },
        { status: 400 }
      );
    }

    if (password && password.length < 8) {
      return NextResponse.json(
        { error: "Hotspot password must be at least 8 characters" },
        { status: 400 }
      );
    }

    if (password && password.length > 63) {
      return NextResponse.json(
        { error: "Hotspot password must be 63 characters or less" },
        { status: 400 }
      );
    }

    // Preserve the stored WPA key when a request omits `password`. The Settings
    // toggle and SSID-rename actions POST only {ssid, enabled} (the GET handler
    // returns hasPassword, not the value, so the client can't resend it) — with
    // the old `password || undefined`, setMany would DELETE the key and the AP
    // would come back up OPEN. Only clear it if the caller explicitly asks.
    const storedPassword = await get("hotspot_password");
    const existingPassword = typeof storedPassword === "string" && storedPassword.length >= 8
      ? storedPassword
      : undefined;
    const effectivePassword = password ? password : existingPassword;

    const updates: Record<string, unknown> = {
      hotspot_ssid: ssid.trim(),
      hotspot_password: effectivePassword || undefined,
    };
    if (typeof enabled === "boolean") {
      updates.hotspot_enabled = enabled;
    }
    await setMany(updates);

    const isEnabled = typeof enabled === "boolean" ? enabled : (await get("hotspot_enabled")) !== false;

    // Write shell-sourceable env file for start-ap.sh
    const envLines = [`HOTSPOT_SSID=${shellQuote(ssid.trim())}`];
    if (effectivePassword) {
      envLines.push(`HOTSPOT_PASSWORD=${shellQuote(effectivePassword)}`);
    }
    if (!isEnabled) {
      envLines.push(`HOTSPOT_DISABLED=1`);
    }
    await fs.mkdir(path.dirname(HOTSPOT_ENV_PATH), { recursive: true });
    await fs.writeFile(HOTSPOT_ENV_PATH, envLines.join("\n") + "\n", {
      mode: 0o600,
    });

    // Start or stop the AP service based on enabled state.
    //
    // FOUR OUTCOMES, NOT ONE BOOLEAN. `apRestarted: false` used to mean all of
    // "we deliberately held off", "we stopped the AP as asked" and "the toggle
    // THREW and nothing happened" — three different facts, and only one of them
    // is fine. The deferral is a designed behaviour the wizard must treat as
    // success; the throw is a box whose hotspot is not in the state its owner
    // just asked for, reported to that owner as "Settings saved". So the verdict
    // is named, and a failure carries its reason.
    let apAction: HotspotApAction = isEnabled ? "deferred" : "stopped";
    let apWarning: string | null = null;
    try {
      if (isEnabled) {
        // Single-radio guard: if the box is currently a WiFi *client* (it joined
        // a network back at Step 1), starting the AP would tear the radio off
        // that network and sever this very connection. Defer — the saved
        // settings apply on the next AP start (e.g. the end-of-setup reboot).
        const iface = process.env.NETWORK_INTERFACE || "wlP1p1s0";
        if (await isWifiClient(iface)) {
          console.warn(
            "[hotspot] Box is a WiFi client; deferring AP restart to avoid severing the connection"
          );
        } else {
          // reset-failed first — see the note in system/hostname/route.ts.
          await execFileAsync("/usr/bin/sudo", [
            "/usr/bin/systemctl",
            "reset-failed",
            "clawbox-root-update@restart_ap.service",
          ]).catch(() => {});
          await execFileAsync("/usr/bin/sudo", [
            "/usr/bin/systemctl",
            "start",
            "clawbox-root-update@restart_ap.service",
          ]);
          apAction = "restarted";
        }
      } else {
        // Stop the AP — run stop-ap.sh directly since clawbox user can execute it
        const stopScript = path.join(
          process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
          "scripts",
          "stop-ap.sh"
        );
        await execFileAsync("bash", [stopScript], { timeout: 15_000 });
      }
    } catch (apErr) {
      console.warn("[hotspot] Failed to toggle AP:", apErr);
      // Still not fatal — the settings ARE saved and apply at the next AP start
      // — but it stops being invisible.
      apAction = "failed";
      apWarning = isEnabled
        ? "Your hotspot settings were saved, but this ClawBox could not restart "
          + "its hotspot. The new settings apply the next time it starts."
        : "Your hotspot settings were saved, but this ClawBox could not switch "
          + "its hotspot off. It may still be broadcasting until the next restart.";
    }

    // The GET handler caches for 3s, which is long enough to answer the reload
    // that follows this save with the settings it just replaced.
    getCache = null;

    // apRestarted tells the wizard whether the connection was actually dropped
    // (so it should show the reconnect handoff) vs. saved without disruption.
    // Kept, and now derived from the verdict rather than being it.
    return NextResponse.json({
      success: true,
      apRestarted: apAction === "restarted",
      apAction,
      ...(apWarning ? { warning: apWarning } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to save hotspot settings",
      },
      { status: 500 }
    );
  }
}

/** Safely quote a value for shell assignment */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Is the WiFi radio currently a client on a network (i.e. NOT hosting the setup
 *  AP)? Starting the AP in that state drops the existing client connection, so
 *  the caller defers the restart. Mirrors the GET handler's blockedBy probe. */
async function isWifiClient(iface: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "nmcli",
      ["-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"],
      { timeout: 3_000 }
    );
    const rows = stdout.split("\n").filter(Boolean).map(parseNmcliTerseLine);
    return rows.some(
      (r) => r[1] === "802-11-wireless" && r[2] === iface && r[0] !== "ClawBox-Setup"
    );
  } catch {
    return false;
  }
}
