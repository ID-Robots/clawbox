import { NextResponse } from "next/server";
import { historyExportAll } from "@/lib/coding-agent";
import { safeRunId } from "@/lib/coding-agent-artifacts";
import { archivedRunZipSources } from "@/lib/coding-run-history";
import { hasOwnerSession } from "@/lib/owner-session";
import { zipResponseStream } from "@/lib/zip-writer";

export const dynamic = "force-dynamic";

/**
 * GET ?runId=run-xxxxxxxx → one ARCHIVED run as a .zip (its bundle: run.json,
 *                           archive.json, evidence/, inputs/, transcript.jsonl
 *                           and the stream logs it had).
 * GET                     → the whole run history as a .zip — see
 *                           historyExportSources for the layout.
 *
 * OWNER-ONLY. The export carries every run's inputs and Claude Code
 * transcripts, which the assistant's own bearer has no business walking off
 * with in one request; the owner's browser session is what downloads it.
 *
 * Streamed: the archive is written as it is read from the flash, so a history
 * of gigabytes costs the board a read buffer, not its size in memory.
 */
function zipResponse(stream: ReadableStream<Uint8Array>, filename: string): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      // The name is built from a run id rebuilt from its alphabet, or a date:
      // nothing in it needs escaping.
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Exporting the run history needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const url = new URL(request.url);
  const runIdRaw = url.searchParams.get("runId");
  if (runIdRaw !== null) {
    const runId = safeRunId(runIdRaw);
    const sources = runId ? archivedRunZipSources(runId) : null;
    if (!runId || !sources) {
      return NextResponse.json({ error: "There is no archived run with that id.", kind: "not_found" }, { status: 404 });
    }
    return zipResponse(zipResponseStream(sources), `clawbox-${runId}.zip`);
  }
  const day = new Date().toISOString().slice(0, 10);
  console.error("[coding-agent] the owner exported the run history");
  return zipResponse(zipResponseStream(historyExportAll()), `clawbox-run-history-${day}.zip`);
}
