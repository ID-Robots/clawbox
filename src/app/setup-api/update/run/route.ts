export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { startUpdate, isUpdateCompleted } from "@/lib/updater";
import { requireSession } from "@/lib/route-auth";
import { hasPersonSession } from "@/lib/owner-session";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { PowerApprovalConflict, requestPowerApproval } from "@/lib/power-approval";
import { prefetchUpdateWhatsNew } from "@/lib/update-whats-new-server";
import { HARNESS_DOWNGRADE_OVERRIDE_FLAG } from "@/lib/harness-downgrade";
import { activeAgentWork } from "@/lib/update-busy";
import { UPDATE_IGNORE_BUSY_FLAG } from "@/lib/update-constants";

export async function POST(request: Request) {
  // The one destructive route the wizard genuinely needs before a password can
  // exist (UpdateStep is step 2, CredentialsStep is step 3), so it takes the
  // bootstrap carve-out — but only that. The moment `password_configured` (or
  // /etc/shadow) says the device has an owner, an anonymous caller can no
  // longer start a root-privileged git-pull-and-rebuild. TASK-443/445.
  const unauthorized = await requireSession(request, { allowBootstrap: true });
  if (unauthorized) return unauthorized;

  // The agent's MCP bearer is not a person: like update/request (the chat
  // path) it never starts the update, it asks the owner, and the update runs
  // only when they tap Confirm (4.3 bug 2).
  const authHeader = request.headers.get("authorization");
  if (authHeader && verifyMcpBearer(authHeader) && !(await hasPersonSession(request))) {
    try {
      const prompt = await requestPowerApproval("update", "Requested in chat");
      return NextResponse.json({ pendingApproval: true, action: "update", id: prompt.id,
        expiresAt: prompt.expiresAt, telegramPromptSent: prompt.messages.length > 0 }, { status: 202 });
    } catch (err) {
      if (err instanceof PowerApprovalConflict) return NextResponse.json({ error: err.message }, { status: 409 });
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to start update" }, { status: 500 });
    }
  }

  try {
    let force = false;
    // The owner's explicit "Back up and update anyway" for an update that would
    // install an older harness than the one that wrote the box's data. Only a
    // literal `true` counts: anything else is the refusal.
    let allowHarnessDowngrade = false;
    let ignoreBusy = false;
    try {
      const body = await request.json();
      force = !!body.force;
      allowHarnessDowngrade = body?.[HARNESS_DOWNGRADE_OVERRIDE_FLAG] === true;
      ignoreBusy = body?.[UPDATE_IGNORE_BUSY_FLAG] === true;
    } catch {
      // No body or invalid JSON — that's fine
    }

    if (!force) {
      const alreadyDone = await isUpdateCompleted();
      if (alreadyDone) {
        return NextResponse.json({ started: false, already_completed: true });
      }
    }

    // The update stops the gateway and restarts the setup server: agent work
    // running now would die mid-task (GitHub #1269). Say so first; the owner
    // waits, or updates anyway with `ignoreBusy`.
    if (!ignoreBusy) {
      const work = await activeAgentWork();
      if (work.total > 0) {
        return NextResponse.json({ started: false, busy: true, work }, { status: 409 });
      }
    }

    const result = startUpdate({ allowHarnessDowngrade });
    // The /updating screen's "What's new" panel (TASK-1205), read and cached
    // while this server is still up to read it — the rebuild stops it for
    // minutes. Fired, never awaited: the update does not wait for a panel.
    if (result.started) void prefetchUpdateWhatsNew();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start update" },
      { status: 500 }
    );
  }
}
