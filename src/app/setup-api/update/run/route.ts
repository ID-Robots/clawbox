export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { startUpdate, isUpdateCompleted, releaseBusyWait, updateInFlight } from "@/lib/updater";
import { requireSession } from "@/lib/route-auth";
import { prefetchUpdateWhatsNew } from "@/lib/update-whats-new-server";
import { HARNESS_DOWNGRADE_OVERRIDE_FLAG } from "@/lib/harness-downgrade";
import { UPDATE_IGNORE_BUSY_FLAG, describeAgentRuns, updateBusyWaitMs } from "@/lib/update-busy";
import { activeAgentWork } from "@/lib/update-busy-server";

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
    // The owner's "Update anyway" over active agent work (issue #1269). Only a
    // literal `true` counts, as above.
    let ignoreBusy = false;
    try {
      const body = await request.json();
      force = !!body.force;
      allowHarnessDowngrade = body?.[HARNESS_DOWNGRADE_OVERRIDE_FLAG] === true;
      ignoreBusy = body?.[UPDATE_IGNORE_BUSY_FLAG] === true;
    } catch {
      // No body or invalid JSON — that's fine
    }

    // "Update anyway" from /updating, for the run that is holding a gateway
    // stop back for agent work: it ends that wait, it does not start a run.
    if (ignoreBusy && releaseBusyWait()) {
      return NextResponse.json({ started: false, busyReleased: true });
    }

    if (!force) {
      const alreadyDone = await isUpdateCompleted();
      if (alreadyDone) {
        return NextResponse.json({ started: false, already_completed: true });
      }
    }

    // The busy gate: an update stops the assistant, which ends every agent run
    // in flight. Refused while there are any, so the owner can choose between
    // waiting for them and updating anyway. A run that has started anyway
    // still waits, bounded, before each stop (withGatewayStopHeldForAgentWork).
    if (!ignoreBusy && !(await updateInFlight())) {
      const counts = await activeAgentWork();
      if (counts.total > 0) {
        return NextResponse.json({
          busy: true,
          counts,
          waitMs: updateBusyWaitMs(),
          error: `${describeAgentRuns(counts.total)} ${counts.total === 1 ? "is" : "are"} active and the update would stop the assistant. `
            + `Wait for ${counts.total === 1 ? "it" : "them"} to finish, or send ${UPDATE_IGNORE_BUSY_FLAG}: true to update anyway.`,
        }, { status: 409 });
      }
    }

    const result = startUpdate({ allowHarnessDowngrade, ignoreBusy });
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
