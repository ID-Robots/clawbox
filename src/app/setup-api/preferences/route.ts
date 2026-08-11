import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { sanitizePreferences, validatePreference } from "@/lib/preference-schema";
import { personaFilesFor, writeLanguagePersona } from "@/lib/language-persona";

export const dynamic = "force-dynamic";

// Allowed preference keys (prefix-based whitelist)
const ALLOWED_PREFIXES = ["wp_", "desktop_", "ui_", "app_", "installed_", "icon_", "pinned_", "hidden_"];

function isAllowed(key: string) {
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

// GET /setup-api/preferences?keys=wp_opacity,wp_bg_color
// GET /setup-api/preferences?all=1  (returns all pref:* keys)
//
// Values are run through the same rules the write path enforces. A value
// stored before those rules existed is DROPPED rather than served: this
// endpoint feeds the agent-callable `preferences_get` tool, so anything the
// store still holds from an older, unvalidated write must not reach a caller.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const allParam = url.searchParams.get("all");

  if (allParam) {
    // Return all preferences
    const allConfig = await config.getAll();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(allConfig)) {
      if (key.startsWith("pref:")) {
        result[key.slice(5)] = value;
      }
    }
    return NextResponse.json(sanitizePreferences(result));
  }

  const keysParam = url.searchParams.get("keys");
  if (!keysParam) {
    return NextResponse.json({ error: "keys or all param required" }, { status: 400 });
  }
  const keys = keysParam.split(",").filter(isAllowed);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = await config.get(`pref:${key}`);
  }
  return NextResponse.json(sanitizePreferences(result));
}

// POST /setup-api/preferences  { wp_opacity: 80, wp_bg_color: "#111" }
//
// Every value is validated before it is stored. The request is rejected whole
// rather than partially applied — a caller that sent an impossible value
// should learn that, not have the rest of its bundle silently land.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!isAllowed(key)) continue;
      const check = validatePreference(key, value);
      if (!check.ok) {
        console.error(`[preferences] Rejected write: ${check.reason}`);
        return NextResponse.json({ error: check.reason ?? "Invalid preference value" }, { status: 400 });
      }
      entries[`pref:${key}`] = value;
    }
    if (Object.keys(entries).length > 0) {
      await config.setMany(entries);
    }
    // When language changes, update the persona files of the harness that is
    // actually running. Validation above already constrained ui_language to a
    // locale we ship, so nothing free-form reaches the agent's system prompt.
    if (typeof body.ui_language === "string" && body.ui_language) {
      await writeLanguagePersona(body.ui_language, personaFilesFor(await getActiveHarness()));
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[preferences] Invalid request:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
