/**
 * POST /setup-api/prime-radiant/ingest/<id>/retry — start a job over the
 * dead letters of job <id>: the files that still failed after its own second
 * round, and the ones a spent ClawBox AI allowance or a Stop left queued
 * (`queued`: never tried, never failed). They are handed over in one transaction, so the
 * original job's list empties and a second retry finds nothing (409
 * `nothing_to_retry`). A retry while the allowance is still spent asks once
 * and queues them again, it does not dead-letter them. 202
 * `{ job }`, progress on `GET ingest/<new id>/events`; what fails again is
 * the new job's dead letters.
 *
 * 404 `not_found`, 409 `busy` (`runningId`), 412 `no_credential`, 409
 * `cloud_ai_locked` (route-helpers `noEngineRefusal`), 409 `window_too_small`
 * (`IngestWindowError`). The owner
 * (cookie AND same origin) or the assistant through the MCP bearer, like
 * every start.
 */
import { flashUnavailableReason } from "@/lib/prime-radiant/flash-client";
import {
  IngestBusyError,
  IngestWindowError,
  NothingToRetryError,
  UnknownJobError,
  getIngestJob,
  runningJobId,
  safeJobId,
  startIngest,
} from "@/lib/prime-radiant/ingest";
import { fail, json, noEngineRefusal, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await writerGuard(req, "Retrying an ingest");
  if (!gate.ok) return gate.response;
  const id = safeJobId((await ctx.params).id);
  if (!id || !getIngestJob(id)) return fail("not_found", "No such ingest job.", 404);
  const running = runningJobId();
  if (running) return json({ error: "An ingest is already running.", code: "busy", runningId: running }, 409);
  const unavailable = await flashUnavailableReason();
  if (unavailable) return noEngineRefusal(unavailable);
  try {
    return json({ job: await startIngest({ kind: "retry", retryOf: id }, { author: gate.writer.author }) }, 202);
  } catch (err) {
    if (err instanceof IngestBusyError) {
      return json({ error: "An ingest is already running.", code: "busy", runningId: err.runningId }, 409);
    }
    // The box's own model cannot hold one document's page: no job, no dead letter.
    if (err instanceof IngestWindowError) return fail("window_too_small", err.message, 409);
    if (err instanceof UnknownJobError) return fail("not_found", "No such ingest job.", 404);
    if (err instanceof NothingToRetryError) return fail("nothing_to_retry", "That ingest has no documents left to retry.", 409);
    return vaultFailure("ingest retry", err);
  }
}
