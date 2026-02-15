import { NextResponse } from "next/server";
import { getUpdateState, isUpdateCompleted } from "@/lib/updater";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = getUpdateState();

    // If process was restarted but update was previously completed,
    // synthesize a fully-completed state (in-memory state is lost on restart)
    if (state.phase === "idle") {
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
