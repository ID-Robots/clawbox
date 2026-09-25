import { NextResponse } from "next/server";
import { runHistorySummary } from "@/lib/coding-agent";
import { clearArchive, listArchive, readArchivedRun } from "@/lib/coding-run-history";
import { hasOwnerSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

/**
 * The run history the owner's retention setting keeps (TASK-1178; see
 * src/lib/coding-run-history.ts).
 *
 * GET                                  → the settings card's summary: the mode,
 *                                        counts, what it weighs, free space and
 *                                        the disk guard, Claude Code's
 *                                        transcript period per settings file.
 * GET ?view=archive[&offset=&limit=]   → { entries, total, offset }: archived
 *                                        runs, newest first.
 * GET ?view=archive&id=run-xxxxxxxx    → { run }: one archived run, read-only;
 *                                        404 { error } when it is not archived.
 * DELETE ?view=archive                 → { cleared: n }: delete the archive.
 *
 * GET is read-only, and middleware's cookie-or-bearer gate is the whole gate,
 * as it is for the runs listing these runs came from. DELETE is OWNER-ONLY
 * for the reason the runs route's is: these are the account of what the
 * assistant did with a delegated shell, and the party they describe must not
 * be the party that can erase them. The 404 carries a JSON body, as the runs
 * route's does, for the MCP classifier.
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    if (url.searchParams.get("view") === "archive") {
      const id = url.searchParams.get("id");
      if (id) {
        const run = readArchivedRun(id);
        if (!run) {
          return NextResponse.json({ error: "There is no archived run with that id.", kind: "not_found" }, { status: 404 });
        }
        return NextResponse.json({ run });
      }
      const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
      const limitRaw = Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT));
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT)) : DEFAULT_LIMIT;
      return NextResponse.json({ ...listArchive(offset, limit), offset });
    }
    return NextResponse.json(await runHistorySummary());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the run history" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Clearing the run archive needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  const url = new URL(request.url);
  // Named, so a DELETE on the bare route can never be read as "everything".
  if (url.searchParams.get("view") !== "archive") {
    return NextResponse.json({ error: "Say what to clear: ?view=archive.", kind: "invalid" }, { status: 400 });
  }
  try {
    const cleared = clearArchive();
    console.error(`[coding-agent] the owner cleared the run archive (${cleared} run(s))`);
    return NextResponse.json({ cleared });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not clear the run archive" },
      { status: 500 },
    );
  }
}
