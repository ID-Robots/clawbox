import { NextResponse } from "next/server";
import { reportIncident, type ReportRefusal } from "@/lib/incident-report";
import { INCIDENT_ID_RE } from "@/lib/incidents";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * POST { id } — file one incident as a GitHub issue, or add today's single
 * "+1, seen again" comment to the issue it already has.
 *
 * NOT owner-only, and that is the point of `ask` mode: the MCP bearer is an
 * intended caller. The agent asks the owner in the chat ("ClawBox hit an error
 * — want me to report it to the developers?") and posts here on their yes.
 *
 * The consent this rides on was given once, in Settings, by setting the mode to
 * `ask` or `auto`; while it is `off` this route refuses every caller — owner
 * and agent alike — with a sentence rather than a silence. So the agent cannot
 * widen anything: it can only do the thing the owner already allowed, and
 * `src/lib/incident-report.ts` applies the same mode, GitHub, dedupe and
 * rate-limit rules whichever surface arrives.
 *
 * IT IS STILL OUR PAGE ONLY. Dropping the owner gate is not the same as
 * dropping the ORIGIN gate, and conflating them was a hole: the owner's browser
 * attaches the session cookie to a POST any other site fires at the box, so a
 * cross-site page could publish an incident to a public issue tracker without
 * the per-incident consent this route's whole design rests on. `isSameOriginRequest`
 * refuses that and leaves the agent alone by construction — a caller with
 * neither `Origin` nor `Sec-Fetch-Site` (the MCP server, curl) is allowed
 * through to whatever its own credential earns it, which is the guard's
 * documented contract.
 *
 * Nothing in the request decides WHAT is sent: the id names a record whose text
 * was sanitized when it was captured, and the body template is fixed. A caller
 * cannot compose an issue.
 */

/** One HTTP status per refusal, so a caller can tell "not yet" from "never". */
const STATUS: Record<ReportRefusal, number> = {
  // The owner said no. A conflict with the box's state, not a bad request.
  off: 409,
  no_github: 409,
  rate_limited: 429,
  not_found: 404,
  // Both are "ask again later": the box could not reach GitHub this time.
  search_failed: 503,
  gh_failed: 503,
};

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Reports can only be sent from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "malformed" }, { status: 400 });
  }
  const id = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { id?: unknown }).id
    : undefined;
  // Held to the shape the store MINTS, not merely to "a non-empty string".
  // An id that is not one is refused before it reaches a lookup or a log line:
  // a newline in it forges entries in the file an operator reads to find out
  // what this box did (CodeQL js/log-injection). The refusal is the same
  // `malformed` an absent id gets, because "there is no such incident" is not
  // a fact this route established.
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!INCIDENT_ID_RE.test(trimmed)) {
    return NextResponse.json({ error: "Name the incident to report, as { id: string }.", code: "malformed" }, { status: 400 });
  }

  const outcome = await reportIncident(trimmed);
  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.detail, code: outcome.code }, { status: STATUS[outcome.code] });
  }
  console.error(`[improvement-program] incident ${trimmed} ${outcome.action} as issue #${outcome.issueNumber}`);
  return NextResponse.json({
    ok: true,
    action: outcome.action,
    issueNumber: outcome.issueNumber,
    ...(outcome.url ? { url: outcome.url } : {}),
  });
}
