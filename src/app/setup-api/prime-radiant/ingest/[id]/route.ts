/**
 * /setup-api/prime-radiant/ingest/<id>
 *
 * GET — one job and its DEAD-LETTER list: `{ job, deadLetter: [{ seq, label,
 * error, attempts, bytes }] }` — the files that still failed after the job's
 * own second round and that no later job has taken over (labels only, never
 * a path on this box). 404 `not_found` for an id this box has no job for.
 * Read-only: never creates the state database.
 *
 * DELETE — stop the job. 202 `{ stopping: true, job }`; the job settles on
 * its own (files it did not reach become dead letters) and its events stream
 * ends. 409 `not_running` (with the job) for one that already finished,
 * 404 `not_found`. OWNER ONLY, cookie AND same origin, like the start.
 */
import { requireSession } from "@/lib/route-auth";
import { getIngestJob, safeJobId, stopIngest } from "@/lib/prime-radiant/ingest";
import { readDeadLetter } from "@/lib/prime-radiant/ingest-store";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { fail, json, ownerWriteGuard, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const id = safeJobId((await ctx.params).id);
  const job = id ? getIngestJob(id) : null;
  if (!id || !job) return fail("not_found", "No such ingest job.", 404);
  try {
    return json({ job, deadLetter: readDeadLetter(vaultDir(), id) });
  } catch (err) {
    return vaultFailure("ingest job", err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await ownerWriteGuard(req, "Stopping an ingest");
  if (denied) return denied;
  const id = safeJobId((await ctx.params).id);
  const job = id ? getIngestJob(id) : null;
  if (!id || !job) return fail("not_found", "No such ingest job.", 404);
  if (!stopIngest(id)) return json({ error: "That ingest is not running.", code: "not_running", job }, 409);
  return json({ stopping: true, job: getIngestJob(id) ?? job }, 202);
}
