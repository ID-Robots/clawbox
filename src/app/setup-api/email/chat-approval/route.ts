// /setup-api/email/chat-approval — turning "approve from chat" on and off.
//
//   GET     what is configured, and whether anyone could actually be asked
//   POST    save the approvals-bot token and/or flip the switch
//   DELETE  forget the bot and switch off
//
// AUTHORIZATION IS THE SAME AS THE APPROVAL QUEUE'S, AND FOR A STRONGER REASON.
// /setup-api/email/pending refuses the MCP bearer because a caller who could
// approve a draft could send mail. This route refuses it because a caller who
// could point this device at a bot IT controls would be able to approve every
// draft from then on — it is the gate's own hinge, so it answers to a signed-in
// browser and nothing else. See src/lib/owner-session.ts.
//
// The token is stored in ClawBox's own config and is NEVER handed to the
// harness: not to openclaw.json, not to `hermes config set`, not to an env
// file. That separation is what keeps the approvals bot's update stream out of
// reach of the process that runs the agent — see email-approval-telegram.ts.

import { NextResponse } from "next/server";
import { get as configGet, set as configSet } from "@/lib/config-store";
import {
  CHAT_APPROVAL_ENABLED_KEY,
  CHAT_APPROVAL_TOKEN_KEY,
  approvalBotToken,
  chatApprovalEnabled,
  ownerChatIds,
  startApprovalPoller,
  stopApprovalPoller,
} from "@/lib/email-approval";
import {
  fetchApprovalBotInfo,
  safeBotToken,
  TelegramApiError,
  TelegramUnavailableError,
} from "@/lib/email-approval-telegram";
import { hasOwnerSession } from "@/lib/owner-session";

export const dynamic = "force-dynamic";

/** Remembered so the panel can show "@YourBot" without another Telegram call. */
const BOT_USERNAME_KEY = "email_approval_bot_username";

function forbidden() {
  return NextResponse.json(
    { error: "Changing how email is approved needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

async function snapshot() {
  const token = await approvalBotToken();
  const username = await configGet(BOT_USERNAME_KEY);
  return {
    enabled: await chatApprovalEnabled(),
    botConfigured: token !== null,
    botUsername: typeof username === "string" ? username : null,
    // A count, not the ids. The panel needs to warn "nobody is paired with this
    // ClawBox on Telegram yet, so nobody can be asked"; it does not need to
    // publish the household's Telegram user ids to do that.
    ownerChats: (await ownerChatIds()).length,
  };
}

export async function GET(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
  try {
    return NextResponse.json(await snapshot());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read the chat approval settings" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: { enabled?: unknown; botToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // A token, when one was sent. Checked against Telegram before it is stored:
  // saving a dead token would leave the owner with a switch that is on and a
  // bot that never speaks, which is the failure mode this feature can least
  // afford — a draft nobody is ever asked about.
  if (body.botToken !== undefined) {
    if (typeof body.botToken !== "string" || !body.botToken.trim()) {
      return NextResponse.json({ error: "A bot token is required" }, { status: 400 });
    }
    const token = safeBotToken(body.botToken);
    if (!token) {
      return NextResponse.json({ error: "That is not a Telegram bot token" }, { status: 400 });
    }

    const mainToken = await configGet("telegram_bot_token");
    if (typeof mainToken === "string" && safeBotToken(mainToken) === token) {
      // The whole design rests on this bot's updates being ours alone. Handing
      // it the token the harness is already long-polling would make both
      // pollers fight ("Conflict: terminated by other getUpdates request") and
      // take the owner's normal Telegram chat down with it.
      return NextResponse.json(
        {
          error:
            "This is the bot ClawBox already chats with. Approvals need a second bot, so the approval never travels through the same connection as the conversation.",
          kind: "same_bot",
        },
        { status: 400 },
      );
    }

    try {
      const info = await fetchApprovalBotInfo(token);
      await configSet(CHAT_APPROVAL_TOKEN_KEY, token);
      await configSet(BOT_USERNAME_KEY, info.username);
    } catch (err) {
      if (err instanceof TelegramUnavailableError) {
        return NextResponse.json(
          { error: "Could not reach Telegram to check this token.", kind: "unavailable" },
          { status: 503 },
        );
      }
      const message = err instanceof TelegramApiError ? err.message : "Telegram rejected this bot token";
      return NextResponse.json({ error: message, kind: "invalid_token" }, { status: 400 });
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    }
    if (body.enabled && (await approvalBotToken()) === null) {
      return NextResponse.json(
        { error: "Add an approvals bot token before switching this on.", kind: "no_bot" },
        { status: 409 },
      );
    }
    await configSet(CHAT_APPROVAL_ENABLED_KEY, body.enabled);
    if (body.enabled) startApprovalPoller();
    else stopApprovalPoller();
  }

  return NextResponse.json({ success: true, ...(await snapshot()) });
}

export async function DELETE(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();
  // Order matters only in that the switch must not survive the token: an
  // enabled flag with no bot behind it is the "nobody is ever asked" state.
  await configSet(CHAT_APPROVAL_ENABLED_KEY, false);
  await configSet(CHAT_APPROVAL_TOKEN_KEY, undefined);
  await configSet(BOT_USERNAME_KEY, undefined);
  stopApprovalPoller();
  return NextResponse.json({ success: true, ...(await snapshot()) });
}
