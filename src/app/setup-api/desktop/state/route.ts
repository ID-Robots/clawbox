import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import { readJsonObject } from "@/lib/bounded-json";
import { sanitizeDesktopState, stateFromLegacyWindows } from "@/lib/desktop-state";
import { readDesktopState, writeDesktopState } from "@/lib/desktop-state-store";
import { ownerUsername } from "@/lib/owner-username";
import { requireSession, sessionIdentity } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

// GET/PUT /setup-api/desktop/state — the signed-in user's open windows
// (TASK-1306, src/lib/desktop-state.ts): what the desktop brings back on a
// refresh, in this browser or another one.
//
// Every signed-in ClawBox user reaches it (src/lib/non-owner-scope.ts) and
// every one of them reads and writes only their OWN file: the user is the
// session's, never the request's. The MCP bearer and the e2e harness's test
// mode, which carry no person, are the owner.

/** A desktop's state is a few KiB; this is forty windows of eight long-command terminal tabs with room over. */
const MAX_BODY_BYTES = 256 * 1024;

const NO_STORE = { "cache-control": "no-store" };

async function caller(request: Request): Promise<{ username: string; isOwner: boolean } | NextResponse> {
  const denied = await requireSession(request, { allowNonOwner: true });
  if (denied) return denied;
  const identity = await sessionIdentity(request);
  return identity ?? { username: ownerUsername(), isOwner: true };
}

export async function GET(request: Request) {
  const who = await caller(request);
  if (who instanceof NextResponse) return who;
  try {
    let state = await readDesktopState(who.username);
    // A box that saved its workspace before the state was per user kept it in
    // the owner's `desktop_open_windows` preference: brought back once, the way
    // it came back then (on the shelf), until the first save replaces it.
    if (!state && who.isOwner) {
      state = stateFromLegacyWindows(await config.get("pref:desktop_open_windows").catch(() => null));
    }
    return NextResponse.json({ user: who.username, state }, { headers: NO_STORE });
  } catch (err) {
    console.error("[desktop/state] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "The saved windows could not be read.", code: "read_failed" }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(request: Request) {
  const who = await caller(request);
  if (who instanceof NextResponse) return who;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request refused.", code: "cross_origin" }, { status: 403 });
  }
  const read = await readJsonObject(request, MAX_BODY_BYTES, "That desktop state is too large.");
  if (!read.ok) {
    return read.reason === "too_long"
      ? NextResponse.json({ error: "That desktop state is too large.", code: "too_large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 });
  }
  const state = sanitizeDesktopState(read.body.state);
  if (!state) {
    return NextResponse.json({ error: "That is not a desktop state.", code: "invalid_state" }, { status: 400 });
  }
  try {
    await writeDesktopState(who.username, state);
  } catch (err) {
    console.error("[desktop/state] write failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "The windows could not be saved on the box.", code: "write_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, savedAt: state.savedAt, windows: state.windows.length }, { headers: NO_STORE });
}
