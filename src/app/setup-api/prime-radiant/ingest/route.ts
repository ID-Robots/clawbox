/**
 * /setup-api/prime-radiant/ingest
 *
 * POST `{ folders: string[] }` or `{ upload: <batch id> }` — start an ingest
 * job: 202 `{ job }`, progress on `GET ingest/<id>/events`. One job at a time
 * (409 `busy` with `runningId`). Folders are the folder picker's: inside the
 * tree the Files app browses, never a credential store, never ClawBox's own
 * output (`folder_refused`). 412 `no_credential` when the box has no ClawBox AI
 * sign-in, before anything is read.
 *
 * GET — the recent jobs, newest first, and the running one's id.
 *
 * The POST is OWNER ONLY, cookie AND same origin: it reads the owner's files,
 * spends their ClawBox AI allowance and writes the vault, so the MCP bearer
 * and a cross-site page are refused. The GET admits whoever `requireSession`
 * admits.
 */
import { requireSession } from "@/lib/route-auth";
import { flashAvailable } from "@/lib/prime-radiant/flash-client";
import { IngestBusyError, listIngestJobs, runningJobId, startIngest } from "@/lib/prime-radiant/ingest";
import { safeBatchId, stagedBatch } from "@/lib/prime-radiant/ingest-upload";
import { fail, json, ownerWriteGuard, resolveIngestFolders, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return json({ running: runningJobId(), jobs: listIngestJobs() });
}

export async function POST(req: Request) {
  const denied = await ownerWriteGuard(req, "Ingesting documents");
  if (denied) return denied;

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail("invalid", "The request is too large.", 413);
    body = JSON.parse(text);
  } catch {
    return fail("invalid", "The request body is not JSON.", 400);
  }
  const b = (body && typeof body === "object" ? body : {}) as { folders?: unknown; upload?: unknown };
  const hasFolders = b.folders !== undefined;
  const hasUpload = b.upload !== undefined;
  if (hasFolders === hasUpload) return fail("invalid", "Send either folders or an upload batch.", 400);

  const running = runningJobId();
  if (running) return json({ error: "An ingest is already running.", code: "busy", runningId: running }, 409);
  if (!(await flashAvailable())) {
    return fail("no_credential", "Sign this box in to ClawBox AI first; Prime Radiant writes its pages with it.", 412);
  }

  let input: Parameters<typeof startIngest>[0];
  if (hasFolders) {
    const resolved = await resolveIngestFolders(b.folders);
    if (!resolved.ok) return resolved.response;
    input = { kind: "folders", folders: resolved.folders };
  } else {
    const batch = safeBatchId(b.upload);
    const dir = batch ? await stagedBatch(batch) : null;
    if (!batch || !dir) return fail("unknown_batch", "Nothing was uploaded under that batch.", 404);
    input = { kind: "upload", dir, batch };
  }

  try {
    return json({ job: await startIngest(input) }, 202);
  } catch (err) {
    if (err instanceof IngestBusyError) {
      return json({ error: "An ingest is already running.", code: "busy", runningId: err.runningId }, 409);
    }
    return vaultFailure("ingest", err);
  }
}
