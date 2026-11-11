export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readFailureKind } from "@/lib/config-store";
import { readOrgMode, writeOrgMode } from "@/lib/org-mode-server";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/settings/org-mode — the owner's "Organisation mode" switch
 * (src/lib/org-mode.ts says what it narrows).
 *
 * GET `{ orgMode, canChange }`: the switch as stored, and whether the person
 * asking may move it (the owner alone). Whoever the middleware let in may
 * read it — the agent's bearer included; the desktop has it from /users/me.
 *
 * POST `{ orgMode }` is OWNER ONLY, from the owner's own browser and our own
 * page: it decides what every other user on the box may reach, so neither
 * another user, nor the agent's MCP bearer, nor another site's page riding the
 * owner's cookie may move it. Off is the default; nothing but this route
 * writes it.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function GET(req: Request) {
  const who = await personSession(req);
  return NextResponse.json({ orgMode: await readOrgMode(), canChange: who?.isOwner === true }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) {
    return refuse(403, "owner_only", "Only the box owner can turn organisation mode on or off, from their own browser.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "Organisation mode can only be changed from this ClawBox's own pages.");
  }

  let orgMode: boolean;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { orgMode?: unknown }).orgMode
      : undefined;
    if (typeof candidate !== "boolean") return refuse(400, "bad_body", "orgMode must be true or false.");
    orgMode = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  try {
    await writeOrgMode(orgMode);
  } catch (err) {
    // The kind only, never the message: see readFailureKind.
    console.error("[org-mode] the switch could not be saved:", readFailureKind(err));
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }
  console.log(`[org-mode] the owner turned organisation mode ${orgMode ? "on" : "off"}`);
  return NextResponse.json({ orgMode: await readOrgMode(), canChange: true }, { headers: NO_STORE });
}
