export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readFailureKind } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { readOpenclawShared, writeOpenclawShared } from "@/lib/openclaw-sharing";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/settings/openclaw-sharing — the owner's "Share OpenClaw with all
 * users" switch (src/lib/non-owner-scope.ts says what it opens).
 *
 * GET `{ shared, canChange, available }`: the switch as stored, whether the
 * person asking may move it (the owner alone), and whether OpenClaw is this
 * box's assistant at all — on Hermes there is no OpenClaw app to share.
 *
 * POST `{ shared }` is OWNER ONLY, from the owner's own browser and our own
 * page: it hands every other user the console that lists every conversation
 * on the box and the gateway token it carries, so neither another user, nor
 * the agent's MCP bearer, nor another site's page riding the owner's cookie
 * may make that decision. Off is the default; nothing but this route writes it.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

async function state(isOwner: boolean) {
  const [shared, harness] = await Promise.all([readOpenclawShared(), getActiveHarness().catch(() => null)]);
  return { shared, canChange: isOwner, available: harness === "openclaw" };
}

export async function GET(req: Request) {
  const who = await personSession(req);
  return NextResponse.json(await state(who?.isOwner === true), { headers: NO_STORE });
}

export async function POST(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) {
    return refuse(403, "owner_only", "Only the box owner can share OpenClaw, from their own browser.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "OpenClaw can only be shared from this ClawBox's own pages.");
  }

  let shared: boolean;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { shared?: unknown }).shared
      : undefined;
    if (typeof candidate !== "boolean") return refuse(400, "bad_body", "shared must be true or false.");
    shared = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  try {
    await writeOpenclawShared(shared);
  } catch (err) {
    // The kind only, never the message: see readFailureKind.
    console.error("[openclaw-sharing] the switch could not be saved:", readFailureKind(err));
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }
  console.log(`[openclaw-sharing] the owner ${shared ? "shared OpenClaw with" : "took OpenClaw back from"} every user`);
  return NextResponse.json(await state(true), { headers: NO_STORE });
}
