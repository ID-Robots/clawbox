/**
 * POST /setup-api/prime-radiant/ingest/upload?name=<file name>[&batch=<id>]
 *
 * One dropped document as the raw request body. The first file of a drop
 * comes without `batch` and gets one in the answer; the rest of the drop sends
 * it back. Then `POST ingest { upload: <batch> }` ingests the batch.
 *
 * 200 `{ batch, name, bytes }` — `name` is the name it was staged under (a
 * rebuilt, never-clashing one). Refusals as `{ error, code }`: 400
 * `invalid_name` (not a .txt/.md/.pdf/.docx), 400 `empty`, 404
 * `unknown_batch`, 409 `batch_full`, 413 `too_large` (9 MiB a document: the
 * middleware keeps only the first 10 MiB of a body), 507 `disk_full` (the box's disk
 * reserve).
 *
 * OWNER ONLY, cookie AND same origin, like the ingest it feeds.
 */
import { stageUpload } from "@/lib/prime-radiant/ingest-upload";
import { fail, json, ownerWriteGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  invalid_name: "Prime Radiant reads .txt, .md, .pdf and .docx documents.",
  empty: "The file is empty.",
  unknown_batch: "That upload batch is not there any more. Drop the files again.",
  batch_full: "One drop holds at most 200 files and 500 MB.",
  too_large: "That document is too large to drop (9 MB at most). Ingest it from its folder instead.",
  disk_full: "The box does not have room for that file.",
  write_failed: "The file could not be saved.",
};

export async function POST(req: Request) {
  const denied = await ownerWriteGuard(req, "Uploading documents");
  if (denied) return denied;
  const url = new URL(req.url);
  const lengthHeader = req.headers.get("content-length");
  const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  let result;
  try {
    result = await stageUpload(req.body, url.searchParams.get("name"), url.searchParams.get("batch"), declared);
  } catch (err) {
    console.error("[prime-radiant] upload:", err instanceof Error ? err.message : err);
    return fail("write_failed", MESSAGES.write_failed, 500);
  }
  if (!result.ok) return fail(result.code, MESSAGES[result.code] ?? MESSAGES.write_failed, result.status);
  return json({ batch: result.batch, name: result.name, bytes: result.bytes });
}
