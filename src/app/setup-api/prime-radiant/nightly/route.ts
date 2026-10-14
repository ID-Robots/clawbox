/**
 * GET /setup-api/prime-radiant/nightly — the nightly pass: `{ running,
 * nextRunAt, runs }` (the next scheduled slot in unix ms, 0 when the schedule
 * is off; recent passes newest first). Never creates anything.
 */
import { requireSession } from "@/lib/route-auth";
import { listNightlyRuns, runningNightlyId } from "@/lib/prime-radiant/nightly";
import { nextRunAtMs } from "@/lib/prime-radiant/nightly-scheduler";
import { json } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return json({ running: runningNightlyId(), nextRunAt: nextRunAtMs(), runs: listNightlyRuns() });
}
