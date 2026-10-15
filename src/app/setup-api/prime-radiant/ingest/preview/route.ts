/**
 * POST /setup-api/prime-radiant/ingest/preview `{ folders: string[] }`
 *
 * What `POST ingest { folders }` would read, before it starts: 200
 * `{ preview: { documents, skips, topFolders, codeProjects, truncated, notes } }`
 * — the number of documents, everything left out by reason (code projects,
 * excluded folders, boilerplate, temporary files, machine-generated text,
 * files too large, other kinds), the folders holding the most documents, and
 * the code projects not gone into, labelled like sources (home folded,
 * redacted). The same walk and the same settings as the job (exclude list,
 * "Skip code projects"); nothing is sent anywhere and nothing is written.
 *
 * Folders follow the ingest's rule: 400 `invalid` (none, or more than 20),
 * 404/400 `folder_not_found`, 400 `folder_refused` (ClawBox's own output),
 * each with the folder's `index`.
 *
 * OWNER ONLY, cookie AND same origin: it lists what is in the owner's folders.
 */
import { previewFolders } from "@/lib/prime-radiant/ingest-sources";
import { fail, json, ownerWriteGuard, readJsonBody, resolveIngestFolders } from "@/lib/prime-radiant/route-helpers";
import { readSettings } from "@/lib/prime-radiant/settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await ownerWriteGuard(req, "Previewing an import");
  if (denied) return denied;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { folders?: unknown };
  const resolved = await resolveIngestFolders(b.folders);
  if (!resolved.ok) return resolved.response;
  const settings = readSettings();
  try {
    const preview = await previewFolders(resolved.folders, {
      exclude: settings.ingest.exclude,
      skipCodeProjects: settings.ingest.skipCodeProjects,
      signal: req.signal,
    });
    return json({ preview });
  } catch (err) {
    if (req.signal.aborted) return fail("aborted", "The preview was cancelled.", 499);
    console.error("[prime-radiant] ingest preview:", err instanceof Error ? err.message : err);
    return fail("preview_failed", "The folders could not be counted.", 500);
  }
}
