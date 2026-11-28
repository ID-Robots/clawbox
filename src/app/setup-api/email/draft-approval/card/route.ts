// POST /setup-api/email/draft-approval/card — the approval card for one draft.
//
// Body: {"draftId": "<id>", "reopen"?: true, "acknowledged"?: <number>}.
// Answers the draft as the mail send backend holds it (to, cc, bcc, subject,
// body preview) and, while it waits for an answer, a one-time approval token
// bound to the signed-in person, the draft id and the draft's content hash —
// src/lib/mail-draft-approval.ts. `acknowledged` is the `uncertainty` of the
// lost-Send warning a "Review again" answers; without the current one, a
// draft whose Send was lost is answered `uncertain`, never with a token.
//
// A PERSON ONLY. The MCP bearer middleware admits elsewhere gets the same 403 as
// no credential at all: a token minted here is half of a Send, and the assistant
// must never hold one. A cross-site page riding the cookie is refused too.

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/bounded-json";
import { mintCard } from "@/lib/mail-draft-approval";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;

function refusal(error: string, kind: string, status: number) {
  return NextResponse.json({ error, kind }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const identity = await personSession(request);
  if (!identity) return refusal("Approving an e-mail draft needs a signed-in browser session.", "owner_only", 403);
  if (!isSameOriginRequest(request)) return refusal("Drafts can only be approved from this ClawBox's own pages.", "cross_origin", 403);

  const parsed = await readJsonObject(request, MAX_BODY_BYTES);
  if (!parsed.ok) return refusal("Invalid request body.", "invalid", 400);

  const answer = await mintCard(identity, parsed.body.draftId, {
    reopen: parsed.body.reopen === true,
    acknowledged: parsed.body.acknowledged,
  });
  return NextResponse.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store" } });
}
