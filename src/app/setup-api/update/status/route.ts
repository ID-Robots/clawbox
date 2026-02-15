import { NextResponse } from "next/server";
import { getUpdateState, isUpdateCompleted, checkContinuation } from "@/lib/updater";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = getUpdateState();

    if (state.phase === "idle") {
      // Check if we need to continue post-restart steps
      const continued = await checkContinuation();
      if (continued) {
        return NextResponse.json(getUpdateState());
      }

      // If previously completed, synthesize all-completed state
      const completed = await isUpdateCompleted();
      if (completed) {
        return NextResponse.json({
          ...state,
          phase: "completed",
          steps: state.steps.map((s) => ({ ...s, status: "completed" })),
        });
      }
    }

    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
