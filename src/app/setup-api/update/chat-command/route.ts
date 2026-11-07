// /setup-api/update/chat-command — /update and the weekly notice's Update
// button, handed over by the harness's own hook (TASK-2260).
//
//   POST { senderId, chatId?, isGroup?, text, channel, harness } -> { handled, outcome? }
//
// WHO CALLS THIS. Not the agent, and not a tool. ClawBox's own plugins inside
// the two harnesses, the same two that already carry the owner's emailed-draft
// reply to /setup-api/email/chat-reply:
//
//   scripts/openclaw-plugins/clawbox-email-directives/update-commands.mjs
//       `before_dispatch`: the typed /update, and the button's tap, which
//       OpenClaw turns into a synthetic `callback_data: clawbox-update` message
//   scripts/hermes-plugins/clawbox_email_directives/update_commands.py
//       `pre_gateway_dispatch` for /update, and a scoped Telegram callback
//       handler for the tap (Hermes drops callback data it does not know)
//
// AUTHORIZATION — the rules of email/chat-reply, for the same reasons:
//
//   1. THE BEARER IS REQUIRED EXPLICITLY. Every real caller is a harness
//      process with no browser session, so the route asks for the bearer and
//      nothing else — a page the owner visits cannot reach it with his cookie.
//   2. THE GATE IS THE SENDER. `senderId` is checked against the Telegram
//      allowlist of the harness named in the body (src/lib/update-notice.ts
//      `claimUpdateChatCommand`), in the owner's private chat only.
//   3. NOTHING HERE CAN START AN UPDATE. The button becomes
//      `requestPowerApproval("update")` — the question /setup-api/update/request
//      already asks for the bearer — and the update runs only when the owner
//      answers it with Confirm on the desktop or the approvals bot. So a caller
//      holding the bearer and lying about the sender gets exactly what the
//      bearer alone already gets: a question on the owner's screen.
//
// ANSWERS FAST, WORKS AFTER. The hook is waiting (Hermes' is synchronous on the
// dispatch path), and a check can take most of a minute when GitHub is slow.
// So the route claims or declines at once, and the check, the question and the
// reply to the owner run after the response. Every failure is `handled: false`
// with a status the hooks read as "not ours".

import { NextResponse } from "next/server";
import { claimUpdateChatCommand, parseUpdateChatCommand } from "@/lib/update-notice";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The only surface whose sender ids the Telegram allowlist can weigh. */
const COMMAND_CHANNEL = "telegram";

/** The harnesses whose hooks may speak here. */
const HARNESSES = new Set(["openclaw", "hermes"]);

/** A few ids, a short message, two names — a few hundred bytes. */
const MAX_BODY_BYTES = 4_096;

/**
 * A bound on how often a command may be answered at all. Not the security
 * property (the sender check is); it is what keeps a stranger hammering
 * /update — or a loop somewhere — from turning into a stream of outbound
 * Telegram messages and GitHub checks. Far above what a person taps.
 */
const COMMAND_BUDGET = { windowMs: 10 * 60 * 1000, max: 20 } as const;

interface ChatCommandBody {
  senderId?: unknown;
  chatId?: unknown;
  isGroup?: unknown;
  text?: unknown;
  channel?: unknown;
  harness?: unknown;
}

function id(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  if (!verifyMcpBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ handled: false }, { status: 403 });
  }

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ handled: false, error: "Body too large" }, { status: 413 });
  }

  let body: ChatCommandBody;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ handled: false, error: "Body too large" }, { status: 413 });
    }
    body = JSON.parse(raw) as ChatCommandBody;
  } catch {
    return NextResponse.json({ handled: false, error: "Expected a JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ handled: false, error: "Expected a JSON object" }, { status: 400 });
  }

  const senderId = id(body.senderId);
  const text = typeof body.text === "string" ? body.text : "";
  if (!senderId || !text) {
    return NextResponse.json({ handled: false, error: "senderId and text are required" }, { status: 400 });
  }

  const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
  if (channel !== COMMAND_CHANNEL) return NextResponse.json({ handled: false });

  const harness = typeof body.harness === "string" ? body.harness.trim().toLowerCase() : "";
  if (!HARNESSES.has(harness)) return NextResponse.json({ handled: false });

  // Ordinary conversation costs nothing: no budget, no lookup.
  if (!parseUpdateChatCommand(text)) return NextResponse.json({ handled: false });

  try {
    const claim = await claimUpdateChatCommand({
      senderId,
      chatId: id(body.chatId) || null,
      isGroup: body.isGroup === true,
      text,
      harness: harness as "openclaw" | "hermes",
    });
    if (claim.handled && claim.run) {
      if (checkRateLimit("update-chat-command", "harness", COMMAND_BUDGET)) {
        void claim.run().catch((err) =>
          console.error("[update/chat-command] answering failed:", err instanceof Error ? err.message : err));
      } else {
        // Still CLAIMED: an unanswered /update must not fall through to the
        // harness's own /update, which updates the harness underneath ClawBox.
        console.error("[update/chat-command] budget exhausted; claimed without an answer");
      }
    }
    if (claim.handled || claim.outcome === "not_owner") console.log(`[update/chat-command] ${claim.outcome} via ${harness}`);
    // `not_owner` travels with an unclaimed answer so the Hermes hook can tell
    // "a stranger: let Hermes' own auth refuse him" from "ClawBox could not be
    // asked", which it fails CLOSED on (update_commands.py).
    return NextResponse.json({
      handled: claim.handled,
      ...(!claim.handled && claim.outcome === "not_owner" ? { outcome: "not_owner" } : {}),
    });
  } catch (err) {
    console.error("[update/chat-command] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ handled: false }, { status: 200 });
  }
}
