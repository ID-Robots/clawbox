import { NextResponse } from "next/server";
import { sendTeamMessage } from "@/lib/coding-team";
import {
  MAX_TEAM_MESSAGE_CHARS,
  MAX_TEAM_MESSAGES_PER_RUN,
  MAX_TEAM_MESSAGES_PER_WINDOW,
  TEAM_MESSAGE_WINDOW_MS,
  TeamMessageError,
  type TeamMessageRefusal,
} from "@/lib/coding-team-messages";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * The HTTP status each refusal answers with. The text's own faults are 400
 * (413 for its length), the sender's claim 403, a team or teammate that is not
 * there 404, a run that can no longer be told anything 409, the caps 429, and
 * the three the BOX answers — no chat session, an edition with no such path, a
 * gateway that did not take it — 503, 501 and 502. The MCP tool words each code
 * itself; the status is for anything else that reads the route.
 */
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
 * POST { teamId, fromRunId, role, to: "sibling" | "lead" | "owner_agent", toRunId?, text }
 *   → { sent: true, to, toRunId, delivered, sessionKey?, at, left, limits }
 *
 * A run of a coding team saying something while it works (src/lib/coding-team.ts
 * `sendTeamMessage`): to another run of the team through the steering path, to
 * the team's lead as an entry on the board, or into the box's main agent's chat.
 * Its caller is the run's own clawbox MCP server (`team_message`), which names
 * the run and the role its environment was started with.
 *
 * Session-gated like every coding-agent route — the owner's cookie or the MCP
 * bearer. There is no owner gate on top of that, and deliberately: an owner's
 * team is made of owner-sourced runs whose ONLY caller here is the bearer, so
 * the gate `coding-agent/message` applies would switch the feature off for every
 * team the owner starts. What stands in for it is the sender check against the
 * team's own board — a live run, on the cast list, in the role it claims, whose
 * record names the same team — which is what the bus has always held a worker
 * to. A caller that is not such a run is refused 403 `FORBIDDEN`, and the
 * refusal is on the board as an alert.
 *
 * OUR PAGE ONLY, the way `coding-agent/message` is: this route puts words in
 * front of a shell and into the assistant's chat, and a cross-site form carries
 * the owner's cookie. `isSameOriginRequest` lets a header-less caller through,
 * which is the MCP server.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "A team message can only be sent from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403 },
    );
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
    const sent = await sendTeamMessage({
      teamId: body.teamId,
      fromRunId: body.fromRunId,
      role: body.role,
      to: body.to,
      toRunId: body.toRunId,
      text: body.text,
    });
    return NextResponse.json({
      sent: true,
      ...sent,
      limits: {
        maxChars: MAX_TEAM_MESSAGE_CHARS,
        perRun: MAX_TEAM_MESSAGES_PER_RUN,
        perWindow: MAX_TEAM_MESSAGES_PER_WINDOW,
        windowMinutes: TEAM_MESSAGE_WINDOW_MS / 60_000,
      },
    });
  } catch (err) {
    if (err instanceof TeamMessageError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...(err.code === "RATE_LIMITED" ? { nextAllowedAt: err.nextAllowedAt } : {}) },
        { status: STATUS_FOR[err.code] },
      );
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not send the team message" }, { status: 500 });
  }
}
