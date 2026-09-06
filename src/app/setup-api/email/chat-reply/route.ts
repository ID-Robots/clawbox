// /setup-api/email/chat-reply — one inbound channel message, handed over by the
// harness's own hook.
//
//   POST { senderId, text, deliverVerdict? } -> { handled, reply? }
//
// WHO CALLS THIS. Not the agent, and not a tool. The two callers are ClawBox's
// own plugins inside the two harnesses:
//
//   scripts/openclaw-plugins/clawbox-email-directives  (`before_dispatch`)
//   scripts/hermes-plugins/clawbox_email_directives    (`pre_gateway_dispatch`)
//
// Each is given the raw inbound message before the model sees it, applies the
// same strict "a verb and a code and nothing else" shape locally, and posts here
// only when it matches. See src/lib/email-approval-reply.ts for why that seam
// is the harness's own and why a second Telegram bot is not needed for it.
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION — READ THIS BEFORE CHANGING ANYTHING HERE
//
// /setup-api/email/pending refuses the MCP bearer outright, because the agent
// holds it and an Approve button answering to the agent is not a gate. This
// route CANNOT do that: it is called from inside the harness process, which has
// no browser session, so it is reached on the same bearer middleware already
// admits. That is a real difference and it is contained by the four things
// below.
//
//   1. THE GATE IS THE SENDER AND THE CODE, NOT THE CALLER. `senderId` is
//      checked against the harness's own Telegram allowlist — the same list,
//      and the same rule, that decides who may press the button in
//      email-approval.ts — and the code names one draft and its content
//      fingerprint. Only the code's HASH is on disk, so a caller that could
//      read the store still could not spend one. Be exact about the limit: an
//      agent with a SHELL is contained by none of this, because it can read the
//      mail credentials out of data/config.json and skip the route entirely.
//      That was true before this route existed; what must not change is that
//      the agent's TOOL surface has no approve verb.
//   1a. AND THE BEARER IS REQUIRED EXPLICITLY, not merely accepted. middleware
//      admits a caller on the bearer OR a session cookie; every real caller
//      here is a harness process holding the bearer and none of them has a
//      cookie, so this route asks for the bearer itself. That takes the
//      BROWSER off this route completely — a page the owner happens to visit
//      cannot reach it with his cookie riding along, which is the shape of
//      cross-site request the other owner-only routes answer with a
//      same-origin check.
//   2. THE MESSAGE NAMES ONE DRAFT. The code was posted to the owner's chat by
//      ClawBox, names exactly one queued draft and its content fingerprint, and
//      is consumed on use. There is no "approve what is waiting" verb here, and
//      a reply that names nothing is refused rather than guessed at.
//   3. NOTHING ON THE TOOL SURFACE REACHES IT. There is no MCP verb for this
//      and there must never be — mcp/tools/email.ts says so in the words the
//      agent is given. The invariant in src/lib/owner-session.ts is unchanged:
//      the agent still cannot approve by asking, and being told "I approve" in
//      a conversation still sends nothing.
//
// WHAT THIS ROUTE THEREFORE IS NOT: a second door onto the queue. Everything it
// can do, the owner could already do with the approvals bot's button; what it
// removes is the BotFather token that path needs, which is the whole of the
// owner's ask.
//
// NEVER 500s OVER A MESSAGE. Every failure answers `handled: false` with a
// status the hook reads as "carry on": a fault in ClawBox must leave the
// harness's ordinary dispatch exactly as it was, not swallow the owner's
// message.

import { NextResponse } from "next/server";
import { applyReplyApproval, parseApprovalReply } from "@/lib/email-approval-reply";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A bound on how often ANY caller may try a code here.
 *
 * Not the security property — the sender check is — but a code is short, and a
 * bound is what keeps "short" from meaning "worth trying". Ten in ten minutes
 * is far above what a person typing does and far below what guessing needs.
 * Counted per process and per bucket, like every other budget in this subtree.
 *
 * SPENT ONLY ON A MESSAGE THAT IS ACTUALLY AN APPROVAL ATTEMPT, which is why
 * the parse below runs first. Charging every message that merely reaches this
 * route would make ordinary conversation exhaust it — and the refusal lands on
 * the NEXT real approval, silently, because the hooks read a 429 as "carry on".
 */
const ATTEMPT_BUDGET = { windowMs: 10 * 60 * 1000, max: 10 } as const;

/** The bucket, shared by every caller: there is at most one harness asking. */
const ATTEMPT_KEY = "harness";

/** The one shape a caller may send. Anything else is a 400, never a guess. */
interface ChatReplyBody {
  senderId?: unknown;
  text?: unknown;
  deliverVerdict?: unknown;
}

export async function POST(request: Request) {
  if (!verifyMcpBearer(request.headers.get("authorization"))) {
    // Identical to what an unknown code gets, and on purpose: a caller that can
    // tell "wrong credential" from "wrong code" apart learns something about
    // what is queued. `handled: false` is also what the hooks read as "carry
    // on", so a misconfigured box degrades to the behaviour it had before.
    return NextResponse.json({ handled: false }, { status: 403 });
  }

  let body: ChatReplyBody;
  try {
    body = (await request.json()) as ChatReplyBody;
  } catch {
    return NextResponse.json({ handled: false, error: "Expected a JSON body" }, { status: 400 });
  }

  const senderId = typeof body.senderId === "string" ? body.senderId : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!senderId || !text) {
    return NextResponse.json({ handled: false, error: "senderId and text are required" }, { status: 400 });
  }

  // Not an approval attempt at all, so nothing is spent and nothing is looked
  // up. `applyReplyApproval` asks the same question again — the cost is one
  // anchored regex, and the alternative is a budget that answers for messages
  // it was never meant to bound.
  if (!parseApprovalReply(text)) return NextResponse.json({ handled: false });

  if (!checkRateLimit("email-chat-reply", ATTEMPT_KEY, ATTEMPT_BUDGET)) {
    console.error("[email/chat-reply] refused: attempt budget exhausted");
    return NextResponse.json({ handled: false, error: "Too many attempts" }, { status: 429 });
  }

  try {
    const result = await applyReplyApproval({
      senderId,
      text,
      deliverVerdict: body.deliverVerdict === true,
    });
    // The outcome is for this device's log, never for the caller: the plugin
    // relays `reply` to a person, and a stranger's refused attempt must not come
    // back as a different answer from an unknown code.
    if (result.handled) {
      // A CODE THAT WORKED CLEARS THE BUDGET, and that is what keeps the bound
      // off the owner. The queue holds up to twenty drafts; an owner clearing
      // them one message at a time would otherwise be refused at the tenth,
      // with nothing but "Too many attempts" to explain it — the false failure
      // this whole subtree keeps producing. Only a caller that cannot name a
      // real draft accumulates, which is the only thing the bound is for.
      resetRateLimit("email-chat-reply", ATTEMPT_KEY);
      console.error(`[email/chat-reply] settled a draft from chat: ${result.outcome}`);
    }
    return NextResponse.json({ handled: result.handled, ...(result.reply ? { reply: result.reply } : {}) });
  } catch (err) {
    console.error("[email/chat-reply] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ handled: false }, { status: 200 });
  }
}
