import { NextResponse } from "next/server";
import { runHistorySummary } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * The run history the owner's retention setting keeps (TASK-1178; see
 * src/lib/coding-run-history.ts).
 *
 * GET → the settings card's summary: the mode, counts, what it weighs, free
 *       space and the disk guard, Claude Code's transcript period per settings
 *       file.
 *
 * Read-only, and middleware's cookie-or-bearer gate is the whole gate, as it
 * is for the runs listing these runs came from. (The archive this route once
 * paged and cleared went with the archive mode, SCA2 C1.)
 */
export async function GET() {
  try {
    return NextResponse.json(await runHistorySummary());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the run history" },
      { status: 500 },
    );
  }
}
