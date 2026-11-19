// POST /setup-api/email/draft-approval/decide — the person's answer to a card.
//
// Body: {"token": "<the card's approval>", "action": "send" | "keep" | "revise"}.
//
//   send    re-reads the draft from the mail send backend and, if it is still
//           exactly what the card showed, asks the backend to send it
//   keep    leaves it in the mailbox's Drafts folder
//   revise  the person is telling the assistant what to change; the card is
//           closed so the old version can no longer be sent from it
//
// THE ONLY PATH FROM A DRAFT TO A SENT MAIL, and it answers to a signed-in
// person's session cookie on this ClawBox's own pages and nothing else. The MCP
// bearer is refused (src/lib/owner-session.ts), a cross-site page is refused
// (src/lib/same-origin.ts), and every check on the token itself — forged,
// someone else's, used, expired, draft changed — is in
// src/lib/mail-draft-approval.ts `decideCard`.

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/bounded-json";
import { decideCard } from "@/lib/mail-draft-approval";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8192;

function refusal(error: string, kind: string, status: number) {
  return NextResponse.json({ error, kind }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const identity = await personSession(request);
  if (!identity) return refusal("Sending an e-mail draft needs a signed-in browser session. Nothing was sent.", "owner_only", 403);
  if (!isSameOriginRequest(request)) return refusal("Drafts can only be sent from this ClawBox's own pages. Nothing was sent.", "cross_origin", 403);

  const parsed = await readJsonObject(request, MAX_BODY_BYTES);
  if (!parsed.ok) return refusal("Invalid request body.", "invalid", 400);

  const answer = await decideCard(identity, parsed.body.token, parsed.body.action);
  return NextResponse.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store" } });
}
