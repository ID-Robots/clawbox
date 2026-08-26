import { NextResponse } from "next/server";
import { clearFinishedRuns, getRun, listRuns, MAX_WAIT_MS, transcriptPath, waitForRun } from "@/lib/coding-agent";
import { hasOwnerSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

/**
 * GET                      → { runs: [...] } newest first (at most `limit`)
 * GET ?id=run-xxxxxxxx     → { run }         404 { error } when unknown
 * GET ?id=…&wait=<seconds> → the same, but held open until the run finishes
 *                            or `wait` elapses (capped), so a caller can
 *                            block instead of polling every few seconds.
 *
 * DELETE                   → forget the finished runs; { cleared: n }.
 *
 * GET is read-only, and middleware's cookie-or-bearer gate is the whole gate
 * for it. The 404 carries a JSON { error } body on purpose — the MCP
 * classifier reads a non-JSON 404 as "this route does not exist on this
 * edition".
 *
 * DELETE is OWNER-ONLY, and refuses the MCP bearer like the switch does.
 * These records are the account of what the assistant did with a delegated
 * shell — which files it touched, what it was refused, what it said it did —
 * and the party they describe must not be the party that can erase them. A
 * run still in flight is kept regardless: it is the handle the stop route
 * needs.
 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Clearing the coding run history needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  try {
    return NextResponse.json({ cleared: clearFinishedRuns() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not clear the coding runs" },
      { status: 500 },
    );
  }
}

/** The app needs the transcript path to offer a live preview; the device is
 *  the only side that knows where Claude Code put it. */
function withTranscript<T extends { sessionId: string | null; directory: string }>(run: T) {
  return { ...run, transcriptPath: transcriptPath(run) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  try {
    if (id) {
      const waitRaw = Number(url.searchParams.get("wait") ?? "0");
      const waitMs = Number.isFinite(waitRaw) ? Math.max(0, Math.min(waitRaw, MAX_WAIT_MS / 1000)) * 1000 : 0;
      const run = waitMs > 0 ? await waitForRun(id, waitMs) : getRun(id);
      if (!run) {
        return NextResponse.json({ error: "There is no coding run with that id.", kind: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ run: withTranscript(run) });
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT));
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT)) : DEFAULT_LIMIT;
    return NextResponse.json({ runs: listRuns(limit).map(withTranscript) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the coding runs" },
      { status: 500 },
    );
  }
}
