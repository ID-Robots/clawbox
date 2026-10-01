import { NextResponse } from "next/server";
import { startAnthropicSwap, type FailureOutcome } from "@/lib/anthropic-swap";
import { reportChatFailure, startGatewaySwap } from "@/lib/anthropic-gateway";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * /setup-api/anthropic/failure — the desktop chat saying "this turn died"
 * (TASK-1260).
 *
 * A gateway turn that fails on the Anthropic account's limit or on a refused
 * credential is reported to whoever sent it, never to this server: the chat
 * sees the `chat` error frame, the server does not. So the chat hands the
 * failure over — the gateway's words, the provider's words it passed on, its
 * failover reason, the session and the turn's text — and this route lets the
 * box act on it (src/lib/anthropic-gateway.ts `reportChatFailure`): mark the
 * account the gateway was on, move every Claude consumer to the next account,
 * and send the turn again into its session, once, when the gateway is back on
 * the new account. With every account limited the turn is held and sent at the
 * earliest reset.
 *
 * OWNER-ONLY AND OUR PAGE ONLY, like the accounts route's writes: a report
 * takes an account out of rotation, and the MCP bearer or another site must
 * not be able to do that with a made-up limit line.
 *
 * Answers as soon as the swap is known, and at the latest after a few
 * seconds — the gateway's restart and the retry carry on behind it; the chat
 * says what it can (`pending: true` when it could not wait).
 */

function refusal(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

/** How long the chat waits for the swap before it is told "switching". */
const ANSWER_WITHIN_MS = 4_000;

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return refusal("Reporting a failed turn needs a signed-in browser session.", "owner_only", 403);
  if (!isSameOriginRequest(request)) return refusal("A failed turn can only be reported from this ClawBox's own pages.", "cross_origin", 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json() as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return refusal("Invalid request body.", "invalid", 400);
  }

  startAnthropicSwap();
  startGatewaySwap();
  const work = reportChatFailure({
    errorMessage: body.errorMessage,
    detail: body.detail,
    reason: body.reason,
    provider: body.provider,
    model: body.model,
    sessionKey: body.sessionKey,
    message: body.message,
  }).catch((err: unknown): null => {
    console.error("[anthropic-failure] could not act on a failed chat turn:", err instanceof Error ? err.message : err);
    return null;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ANSWER_WITHIN_MS);
  });
  const result: FailureOutcome | null | "late" = await Promise.race([work, late]);
  if (timer) clearTimeout(timer);
  if (result === "late") return NextResponse.json({ handled: true, pending: true });
  if (!result || !result.handled) return NextResponse.json({ handled: false });
  return NextResponse.json({
    handled: true,
    pending: false,
    kind: result.kind,
    limitKind: result.limitKind,
    activeLabel: result.activeLabel,
    allLimited: result.allLimited,
    nextResetAt: result.nextResetAt,
    retry: result.retry,
  });
}
