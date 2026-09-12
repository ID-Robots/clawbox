import { NextResponse } from "next/server";
import { githubStatus } from "@/lib/coding-github";
import { MAX_ISSUES_PER_DAY } from "@/lib/incident-report";
import {
  getImprovementMode,
  isImprovementMode,
  listIncidents,
  MAX_INCIDENTS,
  remainingIssuesToday,
  setImprovementMode,
  type Incident,
} from "@/lib/incidents";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * The ClawBox Improvement Program.
 *
 * GET  → the mode, what is queued, and whether GitHub is connected.
 * POST { mode } → set the mode. OWNER ONLY, AND SAME ORIGIN.
 *
 * THE TWO HALVES ARE GATED DIFFERENTLY, deliberately.
 *
 * The READ is open to the MCP bearer as well as the owner's cookie, because the
 * agent is its intended caller: `clawbox_incidents_list` is how "ClawBox hit an
 * error — want me to report it?" gets asked at all. Everything in the answer
 * has been through the sanitizer before it reached the disk, so there is nothing
 * here the agent may not see.
 *
 * The WRITE refuses the bearer (403 `owner_only`) and any other origin (403
 * `cross_origin`), like `coding-agent/enable` and `coding-agent/permissions`.
 * Opting a box into sending its diagnostics to a public issue tracker is the
 * owner's consent, and a tool that could switch it on — or quietly switch it
 * from `ask` to `auto` — would make that consent temporary.
 */

/** The shape a caller sees. Nothing raw: `message`, `stack` and `context` were
 *  sanitized by `recordIncident` before they were ever written. */
function publicIncident(incident: Incident) {
  return {
    id: incident.id,
    fingerprint: incident.fingerprint,
    source: incident.source,
    message: incident.message,
    stack: incident.stack,
    context: incident.context,
    firstSeen: incident.firstSeen,
    lastSeen: incident.lastSeen,
    count: incident.count,
    edition: incident.edition,
    appVersion: incident.appVersion,
    coreVersion: incident.coreVersion,
    issueNumber: incident.issueNumber,
    reportedAt: incident.reportedAt,
  };
}

/** How many incidents one answer carries. The card shows a handful and the
 *  agent needs the recent ones; the whole log is neither's question. */
const LIST_LIMIT = 25;

export async function GET() {
  // No owner gate: the MCP bearer middleware already admitted is the intended
  // reader. An anonymous caller never gets here — middleware refuses it.
  const mode = await getImprovementMode();
  const incidents = listIncidents();
  // Never allowed to fail the read: a box with no `gh` still has a queue worth
  // showing, and the card's "Connect GitHub" line is drawn from this.
  const github = await githubStatus().catch(() => null);
  return NextResponse.json({
    mode,
    repo: "ID-Robots/clawbox",
    pending: incidents.filter((i) => i.issueNumber === null).length,
    reported: incidents.filter((i) => i.issueNumber !== null).length,
    total: incidents.length,
    maxIncidents: MAX_INCIDENTS,
    maxIssuesPerDay: MAX_ISSUES_PER_DAY,
    remainingToday: remainingIssuesToday(MAX_ISSUES_PER_DAY),
    github: { installed: github?.installed ?? false, connected: github?.connected ?? false, login: github?.login ?? null },
    incidents: incidents.slice(0, LIST_LIMIT).map(publicIncident),
  });
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the Improvement Program needs a signed-in browser session.", code: "owner_only" },
      { status: 403 },
    );
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "The Improvement Program can only be changed from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "malformed" }, { status: 400 });
  }
  const mode = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { mode?: unknown }).mode
    : undefined;
  if (!isImprovementMode(mode)) {
    return NextResponse.json(
      { error: 'Invalid body. Expected { mode: "off" | "ask" | "auto" }.', code: "malformed" },
      { status: 400 },
    );
  }
  await setImprovementMode(mode);
  console.error(`[improvement-program] mode set to ${mode} by the owner`);
  // The re-read state, not the mode the caller asked for: the card renders the
  // box's own answer, the way every other settings panel here does.
  return GET();
}
