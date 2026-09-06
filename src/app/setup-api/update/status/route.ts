import { NextResponse } from "next/server";
import {
  getUpdateState,
  isUpdateCompleted,
  checkContinuation,
  getVersionInfo,
  isInterruptedVerdict,
} from "@/lib/updater";
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
    let state = getUpdateState();

    // A REMEMBERED interruption is re-asked, not latched. The verdict is
    // decided from two durable records, and this process is not necessarily the
    // one that wrote them: on the Hermes box the boot hook resumed the second
    // half of an update while this route's copy of the updater sat idle, read
    // "locked, nothing to resume, not completed" off the disk and answered
    // `failed` — with every step pending — over an update that finished 71
    // seconds later, for the life of the web server. Every other failure has a
    // cause of its own and is left exactly as it is.
    if (state.phase === "idle" || isInterruptedVerdict(state)) {
      // Check if we need to continue post-restart steps
      await checkContinuation();
      // Re-read: the call above can resume a run, void the interruption, or
      // DECIDE one. Answering from the state it was called with hid a real
      // failure for a whole polling interval and a resolved one indefinitely.
      state = getUpdateState();
      if (state.phase !== "idle") {
        return NextResponse.json(state);
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
      // `remote.reachable === false` outranks the flag for the same reason drift
      // does: "nothing to do" derived from a check that never reached GitHub is
      // not a fact, and this is the payload the setup wizard reads before it
      // decides whether to auto-advance past the update step (TASK-655).
      const remoteAnswered = versions.remote?.reachable !== false;
      if (completed && remoteAnswered && !drift && !needsUpdate(versions.clawbox) && !needsUpdate(versions.openclaw)) {
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
