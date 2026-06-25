export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { forceResetToChannel } from "@/lib/updater";

/**
 * "Reset to channel & update" — for a device stranded on a non-release branch
 * with local commits, where the normal update is silently withheld. Pins
 * `.update-branch` to the channel and runs the update (whose hard-sync discards
 * the local commits). DESTRUCTIVE; the UI confirms before calling this.
 */
export async function POST() {
  try {
    const result = await forceResetToChannel();
    if (!result.started) {
      // e.g. an update is already running — don't let clients that check
      // res.ok treat this as a successful reset.
      return NextResponse.json(result, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reset to channel" },
      { status: 500 },
    );
  }
}
