/**
 * POST /setup-api/prime-radiant/ingest/<id>/retry — start a job over the
 * dead letters of job <id>: the files that still failed after its own second
 * round. They are handed over in one transaction, so the original job's list
 * empties and a second retry finds nothing (409 `nothing_to_retry`). 202
 * `{ job }`, progress on `GET ingest/<new id>/events`; what fails again is
 * the new job's dead letters.
 *
 * 404 `not_found`, 409 `busy` (`runningId`), 412 `no_credential`. OWNER
 * ONLY, cookie AND same origin, like every start.
 */
import { flashAvailable } from "@/lib/prime-radiant/flash-client";
import {
  IngestBusyError,
  NothingToRetryError,
  UnknownJobError,
  getIngestJob,
  runningJobId,
  safeJobId,
  startIngest,
} from "@/lib/prime-radiant/ingest";
import { fail, json, ownerWriteGuard, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await ownerWriteGuard(req, "Retrying an ingest");
  if (denied) return denied;
  const id = safeJobId((await ctx.params).id);
  if (!id || !getIngestJob(id)) return fail("not_found", "No such ingest job.", 404);
  const running = runningJobId();
  if (running) return json({ error: "An ingest is already running.", code: "busy", runningId: running }, 409);
  if (!(await flashAvailable())) {
    return fail("no_credential", "Sign this box in to ClawBox AI first; Prime Radiant writes its pages with it.", 412);
  }
  try {
    return json({ job: await startIngest({ kind: "retry", retryOf: id }) }, 202);
  } catch (err) {
    if (err instanceof IngestBusyError) {
      return json({ error: "An ingest is already running.", code: "busy", runningId: err.runningId }, 409);
    }
    if (err instanceof UnknownJobError) return fail("not_found", "No such ingest job.", 404);
    if (err instanceof NothingToRetryError) return fail("nothing_to_retry", "That ingest has no documents left to retry.", 409);
    return vaultFailure("ingest retry", err);
  }
}
