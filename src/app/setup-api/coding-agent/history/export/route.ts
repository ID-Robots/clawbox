import { NextResponse } from "next/server";
import { historyExportAll } from "@/lib/coding-agent";
import { hasPersonSession } from "@/lib/owner-session";
import { zipResponseStream } from "@/lib/zip-writer";

export const dynamic = "force-dynamic";

/**
 * GET → the whole run history as a .zip — see historyExportSources for the
 *       layout.
 *
 * OWNER-ONLY. The export carries every run's inputs and Claude Code
 * transcripts, which the assistant's own bearer has no business walking off
 * with in one request; the owner's browser session is what downloads it.
 *
 * Streamed: the zip is written as it is read from the flash, so a history of
 * gigabytes costs the board a read buffer, not its size in memory.
 */
export async function GET(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Exporting the run history needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const day = new Date().toISOString().slice(0, 10);
  console.error("[coding-agent] the owner exported the run history");
  return new Response(zipResponseStream(historyExportAll()), {
    headers: {
      "Content-Type": "application/zip",
      // The name is a fixed prefix and a date: nothing in it needs escaping.
      "Content-Disposition": `attachment; filename="clawbox-run-history-${day}.zip"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
