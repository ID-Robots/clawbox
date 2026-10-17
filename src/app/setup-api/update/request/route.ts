export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasPersonSession } from "@/lib/owner-session";
import { dispatchPowerAction, requestPowerApproval, PowerApprovalConflict } from "@/lib/power-approval";

// The chat path to a software update (MCP `update_run`). Unlike /update/run it
// has no bootstrap carve-out, and a caller without a person session (the MCP
// bearer) never starts the update: it raises the same owner question as a
// restart — desktop prompt plus the approvals bot's Confirm/Cancel buttons —
// and the update runs only when the owner taps Confirm.
export async function POST(req: Request) {
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  let reason: unknown;
  try { ({ reason } = await req.json()); } catch { /* reason is optional */ }

  try {
    if (!(await hasPersonSession(req))) {
      const prompt = await requestPowerApproval("update", typeof reason === "string" ? reason : "Requested in chat");
      return NextResponse.json({ pendingApproval: true, action: "update", id: prompt.id,
        expiresAt: prompt.expiresAt, telegramPromptSent: prompt.messages.length > 0 }, { status: 202 });
    }
    await dispatchPowerAction("update");
    return NextResponse.json({ ok: true, started: true });
  } catch (err) {
    if (err instanceof PowerApprovalConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to start update" }, { status: 500 });
  }
}
