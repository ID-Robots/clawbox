/**
 * /setup-api/prime-radiant/ingest
 *
 * POST `{ folders: string[] }`, `{ files: string[] }` or `{ upload: <batch
 * id> }` — start an ingest job: 202 `{ job }`, progress on `GET
 * ingest/<id>/events`. One job at a time (409 `busy` with `runningId`).
 * Folders are the folder picker's: inside the tree the Files app browses,
 * never a credential store, never ClawBox's own output (`folder_refused`).
 * Files follow the same rule (`file_not_found` / `file_refused`, with
 * `index`) and are staged as one upload batch through the drop's own staging
 * (its names, caps and disk reserve), then ingested like a drop. 412
 * `no_credential` when the box has no ClawBox AI sign-in, before anything is
 * read.
 *
 * GET — the recent jobs, newest first, and the running one's id.
 *
 * The POST reads the owner's files, spends their ClawBox AI allowance and
 * writes the vault: the owner (cookie AND same origin), or the assistant
 * through the MCP bearer when the owner asks it to — never a cross-site page.
 * The GET admits whoever `requireSession` admits.
 */
import fs from "fs/promises";
import { requireSession } from "@/lib/route-auth";
import { flashAvailable } from "@/lib/prime-radiant/flash-client";
import { IngestBusyError, listIngestJobs, runningJobId, startIngest } from "@/lib/prime-radiant/ingest";
import { safeBatchId, stageFiles, stagedBatch } from "@/lib/prime-radiant/ingest-upload";
import { fail, json, resolveIngestFiles, resolveIngestFolders, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

/** A named file the staging refused, worded like the drop's refusals (`ingest/upload`). */
const STAGE_MESSAGES: Record<string, string> = {
  invalid_name: "Prime Radiant reads .txt, .md, .pdf, .docx, .odt and .rtf documents.",
  empty: "That file is empty.",
  batch_full: "One ingest of named files holds at most 200 files and 500 MB; ingest their folder instead.",
  too_large: "That document is too large to ingest by name (9 MB at most); ingest its folder instead.",
  disk_full: "The box does not have room to stage that file.",
  write_failed: "The file could not be read.",
};

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return json({ running: runningJobId(), jobs: listIngestJobs() });
}

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Ingesting documents");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail("invalid", "The request is too large.", 413);
    body = JSON.parse(text);
  } catch {
    return fail("invalid", "The request body is not JSON.", 400);
  }
  const b = (body && typeof body === "object" ? body : {}) as { folders?: unknown; files?: unknown; upload?: unknown };
  const hasFolders = b.folders !== undefined;
  const hasFiles = b.files !== undefined;
  const hasUpload = b.upload !== undefined;
  if ([hasFolders, hasFiles, hasUpload].filter(Boolean).length !== 1) return fail("invalid", "Send one of folders, files or an upload batch.", 400);

  const running = runningJobId();
  if (running) return json({ error: "An ingest is already running.", code: "busy", runningId: running }, 409);
  if (!(await flashAvailable())) {
    return fail("no_credential", "Sign this box in to ClawBox AI first; Prime Radiant writes its pages with it.", 412);
  }

  let input: Parameters<typeof startIngest>[0];
  // The batch staged here from named files: no job owns it until startIngest
  // registers one, so a start that throws (a job that raced in, a vault that
  // could not be opened) must take it away again. A dropped batch is the drop's.
  let namedBatchDir: string | null = null;
  if (hasFolders) {
    const resolved = await resolveIngestFolders(b.folders);
    if (!resolved.ok) return resolved.response;
    input = { kind: "folders", folders: resolved.folders };
  } else if (hasFiles) {
    const resolved = await resolveIngestFiles(b.files);
    if (!resolved.ok) return resolved.response;
    const staged = await stageFiles(resolved.files);
    if (!staged.ok) return json({ error: STAGE_MESSAGES[staged.code] ?? STAGE_MESSAGES.write_failed, code: staged.code, index: staged.index }, staged.status);
    namedBatchDir = staged.dir;
    input = { kind: "upload", dir: staged.dir, batch: staged.batch };
  } else {
    const batch = safeBatchId(b.upload);
    const dir = batch ? await stagedBatch(batch) : null;
    if (!batch || !dir) return fail("unknown_batch", "Nothing was uploaded under that batch.", 404);
    input = { kind: "upload", dir, batch };
  }

  try {
    // The commits of an import the assistant started name it, so it can undo them.
    return json({ job: await startIngest(input, { author: gate.writer.author }) }, 202);
  } catch (err) {
    if (namedBatchDir) await fs.rm(namedBatchDir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof IngestBusyError) {
      return json({ error: "An ingest is already running.", code: "busy", runningId: err.runningId }, 409);
    }
    return vaultFailure("ingest", err);
  }
}
