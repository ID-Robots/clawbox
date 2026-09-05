import { NextResponse } from "next/server";
import { openclawAppsGuard } from "@/lib/openclaw-apps-server";
import fs from "fs/promises";
import path from "path";
import { setSkillEnabled } from "@/lib/openclaw-config";
import { refreshSkillsCache } from "@/lib/openclaw-skill-info";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "/home/clawbox";

/**
 * Maps app settings from the UI to the config files that skills actually read.
 */
const CONFIG_WRITERS: Record<string, (settings: Record<string, string | boolean>) => Promise<void>> = {
  "home-assistant": async (settings) => {
    const configDir = path.join(HOME, ".config", "home-assistant");
    const configFile = path.join(configDir, "config.json");
    await fs.mkdir(configDir, { recursive: true });
    const config: Record<string, unknown> = {};
    if (settings.ha_url) config.url = settings.ha_url;
    if (settings.ha_token) config.token = settings.ha_token;
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  },
};

export async function POST(req: Request) {
  // The App Store is OpenClaw-only; refuse on a Hermes device (the UI hides
  // it, this makes HTTP agree). See src/lib/openclaw-apps-server.ts.
  const blocked = await openclawAppsGuard();
  if (blocked) return blocked;

  try {
    const { appId, settings } = await req.json();
    if (!appId || typeof appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    // "__proto__" passes the charset check but would resolve to
    // Object.prototype in setSkillEnabled — which refuses it too (the
    // invariant lives there); this early check answers a clean 400 rather
    // than a 500. Same guard the KV route's RESERVED_KEYS applies.
    if (appId === "__proto__" || appId === "constructor" || appId === "prototype") {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    if (!settings || typeof settings !== "object") {
      return NextResponse.json({ error: "settings is required" }, { status: 400 });
    }

    // Enable/disable is a direct write of `skills.entries.<id>.enabled` — see
    // setSkillEnabled for why the CLI is not spawned for it. GET
    // /setup-api/apps/skill-info?appId= reads the same key back.
    if ("_setEnabled" in settings) {
      // A string "false" would coerce truthy and enable the skill.
      if (typeof settings._setEnabled !== "boolean") {
        return NextResponse.json({ error: "_setEnabled must be a boolean" }, { status: 400 });
      }
      const enabled = settings._setEnabled;
      try {
        await setSkillEnabled(appId, enabled);
      } catch (err) {
        console.error(`[apps/settings] Failed to toggle ${appId}:`, err instanceof Error ? err.message : err);
        return NextResponse.json({ error: "Failed to toggle skill" }, { status: 500 });
      }
      // The switch just changed what `openclaw skills list --json` will say
      // about this skill — a disabled skill is never `eligible`, which is the
      // field the "Ready / Needs setup" badge is drawn from — so the cached
      // list is invalidated the way install and uninstall invalidate it.
      // Behind the answer: the rescan is a CLI boot and the write has landed.
      refreshSkillsCache();
      return NextResponse.json({ ok: true, enabled });
    }

    // Write config file for the skill
    const writer = CONFIG_WRITERS[appId];
    if (writer) {
      const sanitized: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(settings)) {
        // Never let a caller-supplied key touch the prototype chain.
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        if (typeof v === "string" || typeof v === "boolean") sanitized[k] = v;
        else if (typeof v === "number") sanitized[k] = String(v);
        else return NextResponse.json({ error: `Invalid value type for key "${k}"` }, { status: 400 });
      }
      await writer(sanitized);
      return NextResponse.json({ ok: true, configWritten: true });
    }

    return NextResponse.json({ ok: true, configWritten: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
