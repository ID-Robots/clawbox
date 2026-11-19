// GET /setup-api/email/draft-approval/status[?draft=<id>] — what the assistant's
// `email_draft_card` tool asks before it hands back the card line.
//
// The one route of this feature the MCP bearer may read, and it can read only
// this: whether approval cards are switched on, and — when a draft id is named —
// whether the owner's mailbox has that draft. Never the draft's content, never
// the backend's address or credential, and nothing here can approve or send.
//
// A person's session asks about their own mailbox; the bearer is the owner's
// assistant and asks about the owner's.

import { NextResponse } from "next/server";
import { getSystemUsername } from "@/lib/auth";
import { draftApprovalActive, readDraftApprovalConfig } from "@/lib/mail-draft-approval-config";
import { fetchDraft, isDraftId } from "@/lib/mail-draft-backend";
import { personSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { config, known } = await readDraftApprovalConfig();
  const enabled = known && draftApprovalActive(config);
  const draftId = new URL(request.url).searchParams.get("draft");
  if (!enabled || draftId === null) {
    return NextResponse.json({ enabled }, { headers: { "cache-control": "no-store" } });
  }
  if (!isDraftId(draftId)) {
    return NextResponse.json({ error: "That is not a draft id.", kind: "invalid_draft" }, { status: 400 });
  }
  const user = (await personSession(request))?.username ?? getSystemUsername();
  const fetched = await fetchDraft(config, user, draftId);
  const draft = fetched.ok ? "found" : fetched.reason === "not_found" ? "missing" : "unknown";
  return NextResponse.json({ enabled, draft }, { headers: { "cache-control": "no-store" } });
}
