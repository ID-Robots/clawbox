import { NextResponse } from "next/server";
import { DEFAULT_MEMORY_SCHEDULE, writeMemorySchedule } from "@/lib/clawkeep-memory";
import { refresh as refreshMemoryScheduler } from "@/lib/clawkeep-memory-scheduler";
import { hasOwnerSession } from "@/lib/owner-session";
import { setMemoryShardEnabled, setMemoryShardSetupComplete } from "@/lib/memory-shard";

export const dynamic = "force-dynamic";

/**
 * Start over: switch Memory Shard off, forget the refresh schedule, and put the
 * setup wizard back in front of the owner.
 *
 * What it deliberately does NOT touch: the folders in openclaw.json, the
 * embedding model on the box and the index already built. Re-running the wizard
 * costs nothing when they are still there — it reads the folders back and skips
 * the download — and a "start over" that deleted a working index would be an
 * hours-long re-embed the owner never asked for.
 *
 * OWNER ONLY, like every other write here: middleware admits the MCP bearer and
 * the agent holds it, so without this check the assistant could reopen its
 * owner's onboarding.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Resetting Memory Shard needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  // An EXPLICIT false for both, never a deleted key: an absent completion flag
  // falls back to the switch (see getMemoryShardSetupComplete), so a reset that
  // merely removed it would leave a box that had been switched on believing it
  // had finished setup, and the wizard would never come back.
  await setMemoryShardEnabled(false);
  await setMemoryShardSetupComplete(false);
  // The schedule goes with it. Off already disarms the timer, but a schedule
  // left on disk would re-arm itself the moment the wizard switched the feature
  // back on, at an hour chosen for a setup that no longer exists.
  await writeMemorySchedule({ ...DEFAULT_MEMORY_SCHEDULE });
  await refreshMemoryScheduler();
  console.error("[memory-shard] reset by the owner; the setup wizard will run again");

  return NextResponse.json({ enabled: false, setupComplete: false });
}
