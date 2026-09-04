import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { PREFERENCE_KEY_PREFIX, sanitizePreferences, validatePreference } from "@/lib/preference-schema";
import { personaFilesFor, personaWritesAllowed, writeLanguagePersona } from "@/lib/language-persona";
import { logSafe } from "@/lib/log-safe";

export const dynamic = "force-dynamic";

// Allowed preference keys (prefix-based whitelist)
const ALLOWED_PREFIXES = ["wp_", "desktop_", "ui_", "app_", "installed_", "icon_", "pinned_", "hidden_"];

function isAllowed(key: string) {
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

// Most keys one read may name, so the work and the response a request can ask
// for do not follow the length of its query string.
//
// The largest caller is the `preferences_get` MCP tool, which sends its whole
// readable-prefs allowlist in one request — 9 keys today (READABLE_PREFS in
// mcp/tools/system.ts). The in-app callers ask for one (SettingsApp, i18n,
// mascot-client) or use `all=1`. Headroom is deliberate: if that allowlist ever
// grows past this cap the tool starts getting a 400, so raise this with it.
const MAX_KEYS_PER_READ = 32;

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
    // Null-prototype accumulator: the names come from outside this function, so
    // an assignment here should always define an own property and never reach
    // an inherited one such as `__proto__`. Same below, and in
    // sanitizePreferences, which is where these objects end up.
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(allConfig)) {
      if (key.startsWith(PREFERENCE_KEY_PREFIX)) {
        result[key.slice(PREFERENCE_KEY_PREFIX.length)] = value;
      }
    }
    return NextResponse.json(sanitizePreferences(result));
  }

  const keysParam = url.searchParams.get("keys");
  if (!keysParam) {
    return NextResponse.json({ error: "keys or all param required" }, { status: 400 });
  }
  // Counted before the allowlist filter, so the bound is on what the request
  // names rather than on what survives it.
  const named = keysParam.split(",");
  if (named.length > MAX_KEYS_PER_READ) {
    return NextResponse.json(
      { error: `at most ${MAX_KEYS_PER_READ} keys per request` },
      { status: 400 },
    );
  }
  const keys = named.filter(isAllowed);
  // One read of the store rather than one per key: config.get() re-reads and
  // re-parses the whole file synchronously on every call, so the work of a
  // request would otherwise follow the length of its `keys` parameter.
  const allConfig = await config.getAll();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    result[key] = allConfig[`${PREFERENCE_KEY_PREFIX}${key}`];
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
        // The reason is built from the rejected key, which is caller-supplied
        // and only prefix-checked — bound and sanitise it like any other
        // request-derived log field.
        console.error(`[preferences] Rejected write: ${logSafe(check.reason ?? "")}`);
        return NextResponse.json({ error: check.reason ?? "Invalid preference value" }, { status: 400 });
      }
      entries[`${PREFERENCE_KEY_PREFIX}${key}`] = value;
    }
    if (Object.keys(entries).length > 0) {
      await config.setMany(entries);
    }
    // When language changes, update the persona files of the harness that is
    // actually running. Validation above already constrained ui_language to a
    // locale we ship, so nothing free-form reaches the agent's system prompt.
    //
    // The write is skipped while OpenClaw's first-conversation ritual is
    // pending or has never started: creating USER.md in a brand-new workspace
    // is what tells OpenClaw the agent is already configured, and the setup
    // wizard's language picker fires this route minutes before the owner's
    // first hello. The preference is stored either way, and
    // scripts/gateway-pre-start.sh re-applies it to the persona once the
    // workspace is the agent's own — so a language chosen in the wizard is not
    // lost, only deferred past the introduction.
    //
    // The guard sits here rather than inside writeLanguagePersona because this
    // route is the single door: the desktop, the setup wizard and the agent's
    // own `preferences_set` tool all arrive through it, so closing it here
    // also stops the agent from suppressing its own ritual mid-conversation.
    if (typeof body.ui_language === "string" && body.ui_language) {
      const harness = await getActiveHarness();
      if (await personaWritesAllowed(harness)) {
        await writeLanguagePersona(body.ui_language, personaFilesFor(harness));
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[preferences] Invalid request:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
