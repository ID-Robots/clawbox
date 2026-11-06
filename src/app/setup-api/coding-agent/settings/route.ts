import { NextResponse } from "next/server";
import { CodingAgentError, getConnectedProviders, httpStatusForCodingError } from "@/lib/coding-agent";
import {
  applyCodingSettingsPatch,
  checkCodingSettingsPatch,
  readCodingSettings,
} from "@/lib/coding-settings-patch";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * The coding TEAM's parameters — the settings the assistant may read and
 * change (src/lib/coding-settings-patch.ts, which says what is in the set and
 * what is kept out, and why).
 *
 * GET  → the current values of exactly that set, with the valid choices beside
 *        each: the connected providers and the models a role may be pinned to
 *        on each, the effort levels, the retention modes, the parallel-run
 *        range — so a caller can offer the owner valid options.
 * POST { <any subset of the settable fields> } → validated WHOLE (400
 *        `invalid` with the enable route's own sentence on a bad value; 400
 *        `owner_setting`, naming the Settings page, on a field the assistant
 *        may never change), applied through the enable route's setters, then
 *        answered as { changed, transcripts, settings } with the set re-read.
 *
 * WHO: the OWNER's browser session, or the MCP bearer — the assistant is the
 * party this route exists for. A signed-in NON-owner gets 403 `owner_only`
 * (never 401, which the desktop reads as "signed out"): these are the owner's
 * preferences about the owner's agent and the owner's accounts, where other
 * users share the desktop but not the bill. No credential, or a bearer that
 * is not the box's own, gets the same 403 as the import route gives, so the
 * answer says nothing about which was tried. A browser must be OUR page
 * (`isSameOriginRequest` passes a caller that sends no Origin — the MCP
 * server — and refuses another site's).
 *
 * The enable route stays the only door to the owner's switch, the working
 * folder, the connected accounts, the browser on the owner's screen and the
 * rest of the excluded set: this route refuses those fields by name.
 */
async function admit(request: Request): Promise<NextResponse | null> {
  const who = await personSession(request);
  if (who && !who.isOwner) {
    return NextResponse.json({ error: "Only the box owner can change the coding team's settings.", kind: "owner_only" }, { status: 403 });
  }
  if (!who && !verifyMcpBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Changing the coding team's settings needs the owner's browser session or the box's own agent.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Changing the coding team's settings only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  const refused = await admit(request);
  if (refused) return refused;
  try {
    return NextResponse.json(await readCodingSettings());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to read the coding team's settings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const refused = await admit(request);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  try {
    const checked = await checkCodingSettingsPatch(body, await getConnectedProviders());
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error, kind: checked.kind }, { status: 400 });
    }
    // Who moved the knob, for the journal: a cookie here is the owner's.
    const actor = (await personSession(request))?.isOwner ? "owner" : "assistant";
    return NextResponse.json(await applyCodingSettingsPatch(checked.patch, actor));
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to change the coding team's settings" }, { status: 500 });
  }
}
