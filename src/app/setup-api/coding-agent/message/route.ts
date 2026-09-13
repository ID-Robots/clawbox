import { NextResponse } from "next/server";
import { queueRunMessage } from "@/lib/coding-agent";
import { runLifecycleRoute } from "@/lib/coding-agent-route";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  MAX_QUEUED_RUN_MESSAGES,
  MAX_RUN_MESSAGE_CHARS,
  RunMessageError,
  type RunMessageRefusal,
} from "@/lib/coding-run-messages";

export const dynamic = "force-dynamic";

/**
 * The HTTP status each refusal answers with.
 *
 * The three about the TEXT are 400 — the caller sent something this box does
 * not accept and can fix by sending something else — and the two about the RUN
 * are 409: nothing is wrong with the message, the run simply cannot take it
 * now. The MCP layer reads a 409 as CONFLICT / do-not-retry, which is exactly
 * right for both of them.
 */
const STATUS_FOR: Record<RunMessageRefusal, number> = {
  empty: 400,
  too_long: 413,
  not_plain_text: 400,
  queue_full: 409,
  settled: 409,
};

/**
 * POST { runId, text } → tell a coding run that is still going something.
 *
 * The session check, the `id` alias, the 404 and the owner gate are the
 * factory's (coding-agent-route.ts): agent-callable, with a run the OWNER
 * started answering 403 to the MCP bearer whatever state it is in — the same
 * gating starting and stopping a run have, and for the same reason. A
 * prompt-injected "tell that run to delete the tests" must not reach work the
 * person at the desk asked for.
 *
 * The answer says which of the two deliveries happened, because they mean
 * different things to whoever is waiting: `delivered: true` is "the harness
 * has it, in this turn", and `delivered: false` is "it is queued and goes in
 * at the run's next attempt or when you resume it". A surface that could not
 * tell them apart would have to claim the stronger one.
 *
 * OUR PAGE ONLY, on top of that gate. Every other run route is a lifecycle
 * verb — stop it, pause it, resume it — and the worst a cross-site page could
 * do with the owner's cookie there is end work they wanted. This route puts
 * WORDS in front of a shell that edits files and runs commands, which is a
 * different thing: a form posted as `text/plain` from any page on the web
 * carries the box's cookie and needs no preflight, so "the owner is signed in"
 * is not enough on its own. `isSameOriginRequest` lets a header-less caller
 * through, which is what keeps the MCP bearer — the agent, whose own gate is
 * the run's `source` above — working.
 *
 * The refusal body carries a stable `code` beside its English sentence, so the
 * card can word it in the owner's language and the MCP tool can advise on the
 * right thing — "shorten it" and "that run has finished" need different next
 * steps.
 */
export const POST = runLifecycleRoute({
  verb: "send a message to",
  act: (id, body, request) => {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json(
        { error: "A message to a run can only be sent from this ClawBox's own pages.", code: "cross_origin" },
        { status: 403 },
      );
    }
    const text = (body as { text?: unknown } | null)?.text;
    try {
      const { run, delivered } = queueRunMessage(id, text);
      return NextResponse.json({
        queued: true,
        delivered,
        run,
        limits: { maxQueued: MAX_QUEUED_RUN_MESSAGES, maxChars: MAX_RUN_MESSAGE_CHARS },
      });
    } catch (err) {
      if (err instanceof RunMessageError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS_FOR[err.code] });
      }
      // Anything else — a CodingAgentError, a disk failure — is the factory's
      // to map, in the same words every other run route uses.
      throw err;
    }
  },
});
