import { NextResponse } from "next/server";
import { getRun, listRuns, MAX_WAIT_MS, waitForRun } from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * GET                      → { runs: [...] } newest first (at most `limit`)
 * GET ?id=run-xxxxxxxx     → { run }         404 { error } when unknown
 * GET ?id=…&wait=<seconds> → the same, but held open until the run finishes
 *                            or `wait` elapses (capped), so a caller can
 *                            block instead of polling every few seconds.
 *
 * Read-only; middleware's cookie-or-bearer gate is the whole gate. The 404
 * carries a JSON { error } body on purpose — the MCP classifier reads a
 * non-JSON 404 as "this route does not exist on this edition".
 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

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
      return NextResponse.json({ run });
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT));
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT)) : DEFAULT_LIMIT;
    return NextResponse.json({ runs: listRuns(limit) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the coding runs" },
      { status: 500 },
    );
  }
}
