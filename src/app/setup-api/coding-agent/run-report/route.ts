import { NextResponse } from "next/server";
import { getRun, noteTeamMessageSent } from "@/lib/coding-agent";
import { deliverRunReport } from "@/lib/coding-agent-notify";
import { reportToAssistant } from "@/lib/coding-run-report";
import { TeamMessageError, type TeamMessageRefusal } from "@/lib/coding-team-messages";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/** The team route's statuses, for the same refusal codes (see team/message/route.ts). */
const STATUS_FOR: Record<TeamMessageRefusal, number> = {
  INVALID: 400,
  EMPTY: 400,
  TOO_LONG: 413,
  NOT_PLAIN_TEXT: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  SELF: 400,
  NOT_IN_TEAM: 404,
  SETTLED: 409,
  QUEUE_FULL: 409,
  RATE_LIMITED: 429,
  NO_SESSION: 503,
  UNSUPPORTED: 501,
  NOT_DELIVERED: 502,
};

/**
 * POST { runId, kind: "question" | "blocker" | "milestone", text }
 *   → { sent: true, delivered: "origin" | "main" | "queued", left }
 *
 * A single coding run telling the assistant that started it something mid-run
 * (src/lib/coding-run-report.ts). Its caller is the run's own clawbox MCP
 * server (`assistant_message`), which names the run its environment was
 * started with; the lib checks that the run is real, of no team and running.
 *
 * Session-gated (the MCP bearer), and our page only, like the team route: it
 * puts words into the assistant's chat.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A run report can only be sent from this ClawBox.", code: "cross_origin" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "INVALID" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", code: "INVALID" }, { status: 400 });
  }
  try {
    const sent = await reportToAssistant(
      { runId: body.runId, kind: body.kind, text: body.text },
      { getRun, note: noteTeamMessageSent, deliver: deliverRunReport },
    );
    return NextResponse.json(sent);
  } catch (err) {
    if (err instanceof TeamMessageError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...(err.code === "RATE_LIMITED" ? { nextAllowedAt: err.nextAllowedAt } : {}) },
        { status: STATUS_FOR[err.code] },
      );
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not send the report" }, { status: 500 });
  }
}
