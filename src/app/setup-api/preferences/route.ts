import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  PREFERENCE_KEY_PREFIX,
  safePreferenceKey,
  sanitizePreferences,
  validatePreference,
} from "@/lib/preference-schema";
import {
  DEFERRED_LANGUAGE_KEY,
  personaFilesFor,
  personaWritesAllowed,
  writeLanguagePersona,
} from "@/lib/language-persona";
import { logSafe } from "@/lib/log-safe";
import { requireSession } from "@/lib/route-auth";
import { UI_LANGUAGE_READ } from "@/lib/ui-language-read";

export const dynamic = "force-dynamic";

// The keys a caller with NO session may read: the ones UI_LANGUAGE_READ names
// — the box's UI language, nothing else. /login sits inside the same
// I18nProvider as the desktop and asks for the language before anyone has
// signed in, so the page can greet the owner in it (UI sweep 2026-09-07,
// shell-5). The middleware admits exactly that query, built from the same
// object; this is the route's own half of the cut, so a request that reached
// the handler by another door — a matcher gap, a rewrite — is still told
// nothing but the language. The owner's name, the wallpaper and the installed
// apps stay behind the session.
const ANONYMOUS_READABLE_KEYS: ReadonlySet<string> = new Set<string>(UI_LANGUAGE_READ.keys);

function isAnonymousReadable(allParam: string | null, keysParam: string | null): boolean {
  if (allParam || keysParam === null) return false;
  return keysParam.split(",").every((key) => ANONYMOUS_READABLE_KEYS.has(key));
}

// Allowed preference keys (prefix-based whitelist)
const ALLOWED_PREFIXES = ["wp_", "desktop_", "ui_", "app_", "installed_", "icon_", "pinned_", "hidden_"];

/** Does this door own that name at all? The prefix, and only the prefix. */
function isAllowed(key: string) {
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * The name this route will READ under, or null.
 *
 * Two rules, and the second is why this returns a STRING rather than a boolean.
 * The prefix says which names this door owns; `safePreferenceKey` rebuilds the
 * name out of a bounded alphabet, so the value that reaches `result[…]` below
 * is made of those characters rather than being the caller's own string. The
 * prefix test alone left everything after `ui_` free — any length, any
 * character — and both of this route's writes were on the caller's side of
 * that gap (CodeQL js/remote-property-injection #300 and #301).
 *
 * The READ filters, as it always has for a name with the wrong prefix: a query
 * that names something unreadable is answered with what IS readable rather
 * than refused. The write does not — see the POST handler.
 */
function readableKey(key: string): string | null {
  if (!isAllowed(key)) return null;
  return safePreferenceKey(key);
}

// The prefix whose WRITES need the person, not the agent. `installed_apps` and
// `installed_meta` are the desktop's list of apps and, per entry, where each
// one opens and how: `webappUrl` is what a click navigates to and
// `launch: "window"` makes that navigation a top-level `window.open`. The
// middleware admits the MCP bearer to this route like any other, and the
// bearer is a file anything running as the box's user can read — a
// prompt-injected turn or a delegated coding run — so with only the shape
// check a bearer holder could plant an entry that opens its own page as a
// first-class document. install/uninstall and webapp-registry.ts are the
// contracted writers of these keys and write the store directly; the one
// legitimate caller through THIS route is a browser with the owner's cookie.
// The read side keeps serving the prefix: `ui_list_apps` and the desktop both
// read it, and reading is not the door.
const OWNER_ONLY_WRITE_PREFIX = "installed_";

// Most keys one read may name, so the work and the response a request can ask
// for do not follow the length of its query string.
//
// The largest caller is the `preferences_get` MCP tool, which sends its whole
// readable-prefs allowlist in one request — 9 keys today (READABLE_PREFS in
// mcp/tools/system.ts). The in-app callers ask for one (SettingsApp, i18n,
// mascot-client) or use `all=1`. Headroom is deliberate: if that allowlist ever
// grows past this cap the tool starts getting a 400, so raise this with it.
const MAX_KEYS_PER_READ = 32;

// Most names one WRITE may carry. The same number as the read, and for the
// same reason: the work a request costs must not follow the size of its body.
//
// The read's cap is the one to match rather than a tighter one of its own —
// the two doors take the same names, so a body this route accepts should be
// one a single `keys=` query could ask back. The widest legitimate write is
// the desktop's appearance bundle — four names (`wp_fit`, `wp_bg_color`,
// `wp_opacity`, `wp_id`, page.tsx); every other writer on both pages sends one
// or two, and the MCP `preferences_set` tool sends exactly one. Headroom is
// deliberate, exactly as on the read: a legitimate caller that grows past this
// starts getting a 400, so raise this with it.
const MAX_KEYS_PER_WRITE = 32;

// Most `pref:*` names the store may hold, whatever order they were written in.
//
// The per-request cap bounds one body; this bounds the FILE. Without it a
// caller with a bearer could spend 200 legal requests to reach the same place
// one illegal request of 5000 keys would have — and `config.get()` re-reads
// and re-parses config.json synchronously on every call, so a file grown that
// way takes the desktop, Settings and the setup wizard down with it until
// someone SSHes in. The middleware admits the MCP bearer to this route, and
// the bearer is a file anything running as the box's user can read, including
// a prompt-injected agent turn — see OWNER_ONLY_WRITE_PREFIX above for the
// same threat model.
//
// 500 is the KV route's MAX_ENTRIES (src/app/setup-api/kv/route.ts), which
// bounds data/kv.json for exactly this reason. A box in the field holds a few
// dozen: the desktop's own state plus one `app_<id>_settings` per installed
// app. The cap is on NEW names — a store already at it can still be written
// to, or the wallpaper would stop changing on the box that hit it.
const MAX_STORED_PREFERENCES = 500;

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
  const keysParam = url.searchParams.get("keys");

  // Asked only for a read wider than the language, so the one request /login
  // makes never pays for a cookie verification; `requireSession` mirrors the
  // middleware's own order (bearer, cookie, test mode), so the MCP tool's
  // `preferences_get` and the e2e harness keep the door they have.
  if (!isAnonymousReadable(allParam, keysParam)) {
    const denied = await requireSession(req);
    if (denied) return denied;
  }

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
  const keys = named.map(readableKey).filter((key): key is string => key !== null);
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
// Every name and every value is validated before it is stored. The request is
// rejected whole rather than partially applied — a caller that sent an
// impossible name or an impossible value should learn that, not have the rest
// of its bundle silently land. A name this door does not own at all (the wrong
// prefix) is a different thing and is still skipped: the caller was not asking
// this route to store it.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    // Refused WHOLE, with a code, rather than the key silently dropped: a
    // caller that lands here without a cookie is off-contract and should
    // learn why, and a partial write would leave it believing the entry took.
    // Asked only when the body names such a key, so the ordinary desktop
    // write (wallpaper, window state) never pays for a cookie verification.
    //
    // Loaded here rather than imported at the top, unlike the sibling routes
    // that use the same helper (email/pending, coding-agent/enable): a static
    // import would pull auth.ts into this module's load, and auth.ts builds
    // its secret path from config-store's DATA_DIR at import time. The
    // language suite for this route (src/tests/routes/preferences-language.test.ts)
    // mocks @/lib/config-store with the four functions it uses and no
    // DATA_DIR, so the static chain broke that suite at import. Deferring the
    // load to the one branch that needs it keeps the module's imports what
    // that suite expects; it is not a per-request saving — a module import is
    // paid once per process either way.
    const writesInstalled = Object.keys(body).some((key) => key.startsWith(OWNER_ONLY_WRITE_PREFIX));
    if (writesInstalled && !(await (await import("@/lib/owner-session")).hasOwnerSession(req))) {
      return NextResponse.json(
        { error: "Installed apps can only be changed from the owner's own session", code: "owner_only" },
        { status: 403 },
      );
    }
    // Counted before the loop and on what the body NAMES rather than on what
    // survives the prefix filter, the same way the read counts what the query
    // names: the bound is on the work one request may ask for.
    if (Object.keys(body).length > MAX_KEYS_PER_WRITE) {
      return NextResponse.json(
        { error: `at most ${MAX_KEYS_PER_WRITE} keys per request` },
        { status: 400 },
      );
    }
    // Null-prototype accumulator, like every other one that takes a name from
    // outside: the key written below is `pref:` + a rebuilt name, so it cannot
    // be `__proto__` today, but a later change that drops the prefix or adds a
    // second assignment here must not be the one that discovers this.
    const entries: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(body)) {
      // A name with the wrong prefix is not this door's to write and is
      // skipped, as it always has been. A name WITH the prefix but spelled
      // impossibly is this door's and is refused, like an impossible value:
      // the caller meant a preference, so it should learn that the write did
      // not land rather than read `ok: true` over it — InstalledAppSettings
      // branches on this response (`preferencesRes.ok`), which is exactly how
      // a dropped write would have been rendered as "Saved". The desktop's
      // other writer, `usePreferenceWriter` in page.tsx, still discards the
      // response entirely (`.catch(() => {})`), so for THAT caller this 400 is
      // only a truthful answer, not yet a visible one.
      if (!isAllowed(key)) continue;
      const safeKey = safePreferenceKey(key);
      if (!safeKey) {
        // The name is NOT quoted back: it is caller-supplied, and this body is
        // both returned and logged.
        console.error("[preferences] Rejected write: name outside the preference alphabet");
        return NextResponse.json(
          { error: "preference name is not one this box stores" },
          { status: 400 },
        );
      }
      const check = validatePreference(safeKey, value);
      if (!check.ok) {
        // The reason is built from the rejected key. That key is now bounded
        // and alphabet-only (`safePreferenceKey` above), so `logSafe` is the
        // second rule rather than the only one — kept because this line must
        // stay safe whatever the reason is built from next.
        console.error(`[preferences] Rejected write: ${logSafe(check.reason ?? "")}`);
        return NextResponse.json({ error: check.reason ?? "Invalid preference value" }, { status: 400 });
      }
      entries[`${PREFERENCE_KEY_PREFIX}${safeKey}`] = value;
    }
    if (Object.keys(entries).length > 0) {
      // One read of the store before the write, and only for a body that
      // actually stores something: `setMany` is about to read the same file
      // anyway (read-modify-rewrite), so this costs one extra parse on the
      // debounced write path and nothing at all on a body this door owns no
      // name in.
      const stored = await config.getAll();
      const held = new Set(
        Object.keys(stored).filter((key) => key.startsWith(PREFERENCE_KEY_PREFIX)),
      );
      const adding = Object.keys(entries).filter((key) => !held.has(key)).length;
      if (held.size + adding > MAX_STORED_PREFERENCES) {
        console.error("[preferences] Rejected write: the store already holds the most preferences it may");
        return NextResponse.json(
          { error: `this box stores at most ${MAX_STORED_PREFERENCES} preferences` },
          { status: 400 },
        );
      }
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
    // first hello. The preference is stored either way, so a language chosen
    // in the wizard is not lost, only deferred past the introduction.
    //
    // A deferral is RECORDED rather than merely skipped, because "deferred"
    // needs a due date. Nothing restarts the gateway when the introduction
    // ends, so the ExecStartPre that re-applies the pick could sit unrun for
    // as long as the box stayed up — the desktop in Bulgarian and the agent's
    // persona carrying no language directive at all. The flag is what the
    // five-minute portal heartbeat drains, through
    // applyDeferredLanguagePersona(); see src/lib/language-persona.ts.
    //
    // The guard sits here rather than inside writeLanguagePersona because this
    // route is the single door: the desktop, the setup wizard and the agent's
    // own `preferences_set` tool all arrive through it, so closing it here
    // also stops the agent from suppressing its own ritual mid-conversation.
    if (typeof body.ui_language === "string" && body.ui_language) {
      const harness = await getActiveHarness();
      const allowed = await personaWritesAllowed(harness);
      if (allowed) await writeLanguagePersona(body.ui_language, personaFilesFor(harness));
      // Cleared on the way through as well as set: a pick that landed in the
      // persona owes nothing, and a stale flag would cost one pointless
      // rewrite of the agent's own files on the next tick.
      await config.set(DEFERRED_LANGUAGE_KEY, !allowed);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[preferences] Invalid request:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
