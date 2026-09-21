import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { dispatchPowerAction, isPowerAction, requestPowerApproval, PowerApprovalConflict } from "@/lib/power-approval";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Shutdown/reboot is only ever driven from the desktop (SettingsApp, the
  // taskbar power menu) or the MCP `system_power` tool, both of which are
  // authenticated. Nothing in the wizard calls it, so there is no bootstrap
  // carve-out — an anonymous POST could otherwise power the box off from
  // radio range of the open setup AP. TASK-443.
  const unauthorized = await requireSession(req);
  if (unauthorized) return unauthorized;

  let action: unknown;
  let reason: unknown;
  try {
    ({ action, reason } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isPowerAction(action)) {
    return NextResponse.json(
      { error: "Invalid action. Use 'shutdown' or 'restart'." },
      { status: 400 },
    );
  }

  try {
    if (!(await hasOwnerSession(req))) {
      const prompt = await requestPowerApproval(action, typeof reason === "string" ? reason : "Requested in chat");
      return NextResponse.json({ pendingApproval: true, action, id: prompt.id,
        expiresAt: prompt.expiresAt, telegramPromptSent: prompt.messages.length > 0 }, { status: 202 });
    }
    // Dispatch the power command and wait for systemd to accept it BEFORE
    // responding. `systemctl poweroff|reboot` enqueues the job and returns 0
    // promptly (the actual teardown happens a moment later as units stop), so
    // awaiting here lets us surface a genuine dispatch failure — missing sudo,
    // denied privilege, systemctl not found — as a real 500 instead of the old
    // fire-and-forget path that always reported success. The response still
    // flushes to the client because the enqueue returns well before the web
    // server's own unit is torn down.
    await dispatchPowerAction(action);
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    if (err instanceof PowerApprovalConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to execute power action" },
      { status: 500 },
    );
  }
}
