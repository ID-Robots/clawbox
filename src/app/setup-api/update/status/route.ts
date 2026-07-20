import { NextResponse } from "next/server";
import { getUpdateState, isUpdateCompleted, checkContinuation, getVersionInfo } from "@/lib/updater";

export const dynamic = "force-dynamic";

function needsUpdate(component: { updateAvailable?: boolean; target: string | null }): boolean {
  return component.updateAvailable ?? !!component.target;
}

export async function GET() {
  try {
    const state = getUpdateState();

    if (state.phase === "idle") {
      // Check if we need to continue post-restart steps
      const continued = await checkContinuation();
      if (continued) {
        return NextResponse.json(getUpdateState());
      }

      const versions = await getVersionInfo();

      // If previously completed and still current, synthesize all-completed
      // state. But do not let a stale persisted completion flag hide a newer
      // release: older boxes had `update_completed=true` forever, so
      // /update/status returned "completed" without versions and the setup
      // update card showed "You're up to date" even when /update/versions
      // would have reported a fresh release.
      const completed = await isUpdateCompleted();
      if (completed && !needsUpdate(versions.clawbox) && !needsUpdate(versions.openclaw)) {
        return NextResponse.json({
          ...state,
          phase: "completed",
          steps: state.steps.map((s) => ({ ...s, status: "completed" })),
          versions,
        });
      }

      return NextResponse.json({ ...state, targetVersion: versions.clawbox.target, versions });
    }

    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
