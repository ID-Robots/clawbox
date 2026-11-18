import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getKnown } from "@/lib/config-store";
import { HAS_CONTROL_CHAR, readHotspotSettings, writeHotspotSettings } from "@/lib/hotspot-env";
import { parseNmcliTerseLine, RESTART_AP_TIMEOUT_MS } from "@/lib/network";
import { startRootStep } from "@/lib/root-step-runner";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

let getCache: { body: unknown; at: number } | null = null;
const GET_TTL_MS = 3_000;
// Bumped by every save: a GET that started before one must not cache what it
// read for the next 3 s.
let saveGeneration = 0;

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
  const generation = saveGeneration;
  // `enabled` is the switch as the AP scripts read it (src/lib/hotspot-env.ts);
  // `active` is the radio, whatever the switch says. Settings shows both, so a
  // switch that reads off over a live AP says so instead of looking fine.
  const { ssid, hasPassword, enabled } = await readHotspotSettings();

  const iface = process.env.NETWORK_INTERFACE || "wlP1p1s0";
  let active = false;
  let blockedBy: string | null = null;
  let rows: string[][] = [];
  try {
    const { stdout } = await execFileAsync("nmcli", [
      "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active",
    ], { timeout: 3_000 });
    rows = stdout.split("\n").filter(Boolean).map(parseNmcliTerseLine);
    active = rows.some(r => r[0] === "ClawBox-Setup" && r[2] === iface);
  } catch (err) {
    console.warn("[hotspot] nmcli unavailable:", err);
  }
  // The kernel's view as well: an interface in AP mode is broadcasting,
  // whatever NetworkManager calls the profile that put it there.
  if (!active) active = await radioIsAccessPoint(iface);
  if (enabled && !active) {
    const wifiRow = rows.find(r => r[1] === "802-11-wireless" && r[2] === iface && r[0] !== "ClawBox-Setup");
    if (wifiRow) blockedBy = wifiRow[0];
  }

  const body = { ssid, hasPassword, enabled, active, blockedBy };
  if (generation === saveGeneration) getCache = { body, at: Date.now() };
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

    // data/hotspot.env is one KEY=value per line: a newline in either value
    // would start a line of its own (the disable flag, say).
    if (HAS_CONTROL_CHAR.test(ssid) || (typeof password === "string" && HAS_CONTROL_CHAR.test(password))) {
      return NextResponse.json(
        { error: "Hotspot name and password cannot contain control characters" },
        { status: 400 }
      );
    }

    // Preserve the stored WPA key when a request omits `password`. The Settings
    // toggle and SSID-rename actions POST only {ssid, enabled} (the GET handler
    // returns hasPassword, not the value, so the client can't resend it) — with
    // the old `password || undefined`, setMany would DELETE the key and the AP
    // would come back up OPEN. Only clear it if the caller explicitly asks.
    // A STRICT read: config-store's forgiving `get` answers "nothing stored"
    // for a config.json it cannot read, and the save would then write an env
    // file without the key, so an open AP at the next start.
    const stored = await getKnown("hotspot_password");
    if (!stored.known) {
      return NextResponse.json(
        { error: "The hotspot settings could not be read, so nothing was changed." },
        { status: 500 }
      );
    }
    const storedPassword = stored.value;
    const existingPassword = typeof storedPassword === "string" && storedPassword.length >= 8
      ? storedPassword
      : undefined;
    const effectivePassword = password ? password : existingPassword;

    // A request without `enabled` (an older client) keeps the switch where the
    // AP scripts have it, not where a stale config flag says it is.
    const isEnabled = typeof enabled === "boolean" ? enabled : (await readHotspotSettings()).enabled;

    // data/hotspot.env (what start-ap.sh, ap-watchdog.sh and wifi-failover.sh
    // read) and config, in one call, so they cannot disagree.
    saveGeneration++;
    getCache = null;
    await writeHotspotSettings({
      ssid: ssid.trim(),
      password: effectivePassword || undefined,
      enabled: isEnabled,
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
          await startRootStep("restart_ap", { timeoutMs: RESTART_AP_TIMEOUT_MS });
          apAction = "restarted";
        }
      } else {
        // Stop the AP — run stop-ap.sh directly since clawbox user can execute it
        await execFileAsync("bash", ["/usr/local/libexec/clawbox/stop-ap.sh"], { timeout: 240_000 });
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
    // that follows this save with the settings it just replaced, or with a
    // radio read while the AP was still going down or coming up.
    saveGeneration++;
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

/** Is the interface in AP mode right now (`iw dev <iface> info` says `type AP`)? */
async function radioIsAccessPoint(iface: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("iw", ["dev", iface, "info"], { timeout: 3_000 });
    return /^\s*type AP\s*$/m.test(stdout);
  } catch {
    return false;
  }
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
