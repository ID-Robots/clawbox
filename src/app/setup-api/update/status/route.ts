import { NextResponse } from "next/server";
import { getUpdateState, isUpdateCompleted, checkContinuation, getVersionInfo } from "@/lib/updater";
import { collectBuildIdentity, type DriftReport } from "@/lib/build-identity";

export const dynamic = "force-dynamic";

function needsUpdate(component: { updateAvailable?: boolean; target: string | null }): boolean {
  return component.updateAvailable ?? !!component.target;
}

/**
 * Is this box serving code that is not the code on its disk?
 *
 * Version numbers cannot answer that: `package.json` does not change
 * commit-to-commit, so a box 71 commits behind its own tested branch reports
 * `target: null` and this route synthesised "You're up to date" over the top of
 * a drift banner that was simultaneously telling the owner to run Update
 * (hwtest-round1, 2026-08-24). The two halves of the feature contradicted each
 * other and the more prominent one won.
 *
 * Never throws: the drift read shells out to git, and a device that cannot
 * answer must still get its update status.
 */
async function readDrift(): Promise<DriftReport | null> {
  try {
    const { drift } = await collectBuildIdentity();
    return drift?.detected ? drift : null;
  } catch {
    return null;
  }
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

      const [versions, drift] = await Promise.all([getVersionInfo(), readDrift()]);

      // If previously completed and still current, synthesize all-completed
      // state. But do not let a stale persisted completion flag hide a newer
      // release: older boxes had `update_completed=true` forever, so
      // /update/status returned "completed" without versions and the setup
      // update card showed "You're up to date" even when /update/versions
      // would have reported a fresh release.
      //
      // Drift outranks the flag for the same reason: a completed update that
      // left the box serving another commit's build is precisely the state
      // "completed" must not describe. `drift` travels with every response so
      // the surfaces that render it can say WHY the update is being offered.
      const completed = await isUpdateCompleted();
      if (completed && !drift && !needsUpdate(versions.clawbox) && !needsUpdate(versions.openclaw)) {
        return NextResponse.json({
          ...state,
          phase: "completed",
          steps: state.steps.map((s) => ({ ...s, status: "completed" })),
          versions,
        });
      }

      return NextResponse.json({ ...state, targetVersion: versions.clawbox.target, versions, drift });
    }

    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
