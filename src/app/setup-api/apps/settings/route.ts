import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || "/home/clawbox";
const OPENCLAW_BIN = path.join(HOME, ".npm-global", "bin", "openclaw");

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
  try {
    const { appId, settings } = await req.json();
    if (!appId || typeof appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    if (!settings || typeof settings !== "object") {
      return NextResponse.json({ error: "settings is required" }, { status: 400 });
    }

    // Handle enable/disable via openclaw config
    if ("_setEnabled" in settings) {
      const enabled = !!settings._setEnabled;
      try {
        await execFileAsync(OPENCLAW_BIN, [
          "config", "set",
          `skills.entries.${appId}.enabled`,
          enabled ? "true" : "false",
          "--strict-json",
        ], {
          timeout: 10_000,
          env: { ...process.env, PATH: `${path.dirname(OPENCLAW_BIN)}:${process.env.PATH}` },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Failed to toggle skill: ${msg}` }, { status: 500 });
      }
      return NextResponse.json({ ok: true, enabled });
    }

    // Write config file for the skill
    const writer = CONFIG_WRITERS[appId];
    if (writer) {
      const sanitized: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(settings)) {
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
