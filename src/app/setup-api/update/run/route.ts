export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { startUpdate, isUpdateCompleted } from "@/lib/updater";
import { requireSession } from "@/lib/route-auth";
import { prefetchUpdateWhatsNew } from "@/lib/update-whats-new-server";
import { HARNESS_DOWNGRADE_OVERRIDE_FLAG } from "@/lib/harness-downgrade";

export async function POST(request: Request) {
  // The one destructive route the wizard genuinely needs before a password can
  // exist (UpdateStep is step 2, CredentialsStep is step 3), so it takes the
  // bootstrap carve-out — but only that. The moment `password_configured` (or
  // /etc/shadow) says the device has an owner, an anonymous caller can no
  // longer start a root-privileged git-pull-and-rebuild. TASK-443/445.
  const unauthorized = await requireSession(request, { allowBootstrap: true });
  if (unauthorized) return unauthorized;

  try {
    let force = false;
    // The owner's explicit "Back up and update anyway" for an update that would
    // install an older harness than the one that wrote the box's data. Only a
    // literal `true` counts: anything else is the refusal.
    let allowHarnessDowngrade = false;
    try {
      const body = await request.json();
      force = !!body.force;
      allowHarnessDowngrade = body?.[HARNESS_DOWNGRADE_OVERRIDE_FLAG] === true;
    } catch {
      // No body or invalid JSON — that's fine
    }

    if (!force) {
      const alreadyDone = await isUpdateCompleted();
      if (alreadyDone) {
        return NextResponse.json({ started: false, already_completed: true });
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
