import { NextResponse } from "next/server";
import { openclawAppsGuard } from "@/lib/openclaw-apps-server";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { APP_ID_RE } from "@/lib/code-projects";
import { setSkillEnabled } from "@/lib/openclaw-config";
import { refreshSkillsCache } from "@/lib/openclaw-skill-info";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "/home/clawbox";

/**
 * Maps app settings from the UI to the config files that skills actually read.
 *
 * A Map rather than an object literal, the same way CLOSED_DOMAINS is in
 * src/lib/preference-schema.ts and for the same reason: the key is the
 * caller's `appId`, and an object literal answers for every name on
 * `Object.prototype` too. `CONFIG_WRITERS["toString"]` resolved to
 * `Object.prototype.toString`, which — called with no `this` — returns
 * "[object Undefined]" without throwing, so the route answered
 * `{ ok: true, configWritten: true }` over a file it never wrote and
 * InstalledAppSettings rendered that as "Connected". A Map looks up own
 * entries only, so an unknown name reads as what it is: no writer.
 */
const CONFIG_WRITERS: ReadonlyMap<string, (settings: Record<string, string | boolean>) => Promise<void>> = new Map([
  ["home-assistant", async (settings: Record<string, string | boolean>) => {
    const configDir = path.join(HOME, ".config", "home-assistant");
    const configFile = path.join(configDir, "config.json");
    await fs.mkdir(configDir, { recursive: true });
    const config: Record<string, unknown> = {};
    if (settings.ha_url) config.url = settings.ha_url;
    if (settings.ha_token) config.token = settings.ha_token;
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }],
]);

/**
 * App ids that are already a property of every object literal.
 *
 * They are spelled entirely from APP_ID_RE's alphabet, so the shape rule hands
 * them straight through, and both things this route does with an id read a
 * name off an object: the writer table above, and `skills.entries.<id>` inside
 * setSkillEnabled. The Map covers the first and setSkillEnabled guards three
 * names for the second; this refuses the whole family at the door so the
 * answer is a clean 400 rather than the 500 `Object.prototype.valueOf`
 * produces when it is called as a writer. Taken from Object.prototype itself
 * rather than listed by hand, so the set cannot fall behind the object it
 * describes; `prototype` is added because it is the other spelling callers
 * reach for and no skill is named either.
 */
const RESERVED_APP_IDS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

export async function POST(req: Request) {
  // The App Store is OpenClaw-only; refuse on a Hermes device (the UI hides
  // it, this makes HTTP agree). See src/lib/openclaw-apps-server.ts.
  const blocked = await openclawAppsGuard();
  if (blocked) return blocked;

  try {
    const { appId, settings } = await req.json();
    // APP_ID_RE (src/lib/code-projects.ts) rather than a fourth spelling of it:
    // it carries the LENGTH the producers mint within — 1 to 64 — and the
    // ad-hoc rule here carried none, so a caller could park a megabyte-long
    // `skills.entries.<id>` key inside the harness's own openclaw.json. It is
    // also the bound `app_<appId>_settings` is sized against on the
    // preferences route (MAX_PREFERENCE_KEY_LENGTH), so an id this door takes
    // is one that route can still store the window's form values under.
    if (!appId || typeof appId !== "string" || !APP_ID_RE.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    // Same guard the KV route's RESERVED_KEYS applies: these all pass the
    // charset check and all name something that already exists on every
    // object. See RESERVED_APP_IDS.
    if (RESERVED_APP_IDS.has(appId)) {
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
      // It does not repaint the window on screen (InstalledAppSettings reads
      // skill-info once per mount); it makes the NEXT open right.
      refreshSkillsCache();
      return NextResponse.json({ ok: true, enabled });
    }

    // Write config file for the skill
    const writer = CONFIG_WRITERS.get(appId);
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
      // The other half of this handler, and the same reason: OpenClaw
      // evaluates a skill's required CONFIG (`missing.config` in the scan)
      // exactly as it evaluates its bins and env, and CONFIG_WRITERS exists to
      // write the files a skill reads. Without this, saving a credential left
      // the badge on "Needs setup" until the freshness window was up.
      refreshSkillsCache();
      return NextResponse.json({ ok: true, configWritten: true });
    }

    return NextResponse.json({ ok: true, configWritten: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
