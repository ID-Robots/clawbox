import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  SlackAuthError,
  type SlackBotInfo,
  SlackUnavailableError,
  checkSlackAppToken,
  fetchSlackBotInfo,
  isSlackAppToken,
  isSlackBotToken,
} from "@/lib/slack-api";
import {
  EnvSecretProviderConflictError,
  SLACK_APP_TOKEN_ENV_VAR,
  SLACK_BOT_TOKEN_ENV_VAR,
  isSafeGatewayEnvValue,
  setSlackTokens,
} from "@/lib/openclaw-config";
import { type ChannelPluginFailure, ensureChannelPlugin } from "@/lib/openclaw-channels";
import { setHermesChannelSecrets } from "@/lib/hermes-channels";
import {
  GUIDED_CHANNELS,
  applyChannelRestart,
  scrubSecrets,
  settleChannelSave,
} from "@/lib/guided-channels";

export const dynamic = "force-dynamic";

const LOG_TAG = "slack/configure";

// Slack in Socket Mode, on either edition. The Discord route's contract (see
// guided-channels.ts): both tokens are checked with Slack before anything is
// written, the official plugin is installed before the OpenClaw config write,
// and `success` means the gateway reports the channel connected.
//
// Hermes reads the same two variable names, and `hermes config set` routes
// SLACK_* to ~/.hermes/.env natively, so both editions store the tokens under
// OpenClaw's names.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  // Kept outside the try so the outer catch can scrub them from anything it logs.
  let secrets: string[] = [];
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!isRecord(body)) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    if (!botToken || !appToken) {
      return NextResponse.json(
        { error: "Both the bot token and the app-level token are required", code: "tokens_required" },
        { status: 400 },
      );
    }
    secrets = [botToken, appToken];

    // Shape first (cheap, and the env-file charset), the verdict from Slack next.
    if (
      !isSlackBotToken(botToken) ||
      !isSlackAppToken(appToken) ||
      !isSafeGatewayEnvValue(botToken) ||
      !isSafeGatewayEnvValue(appToken)
    ) {
      return NextResponse.json(
        { error: "That does not look like a Slack bot token and app-level token", code: "token_format" },
        { status: 400 },
      );
    }

    // One after the other, so the answer names the token that is actually
    // wrong rather than whichever request lost a race.
    let bot: SlackBotInfo;
    try {
      bot = await fetchSlackBotInfo(botToken, request.signal);
      await checkSlackAppToken(appToken, request.signal);
    } catch (err) {
      if (err instanceof SlackAuthError) {
        return NextResponse.json({ error: err.message, code: err.problem }, { status: 400 });
      }
      if (err instanceof SlackUnavailableError) {
        return NextResponse.json(
          { error: "Slack could not be reached to check the tokens", code: "slack_unavailable" },
          { status: 502 },
        );
      }
      throw err;
    }

    const harness = await getActiveHarness();

    // ClawBox's own store first, so a harness failure below can never lose the
    // credentials the owner just pasted. Past this point nothing takes the
    // request's signal: a browser that went away must not cancel half a save.
    await set("slack_bot_token", botToken);
    await set("slack_app_token", appToken);

    let installFailure: ChannelPluginFailure | null = null;
    if (harness === "hermes") {
      await setHermesChannelSecrets({
        [SLACK_BOT_TOKEN_ENV_VAR]: botToken,
        [SLACK_APP_TOKEN_ENV_VAR]: appToken,
      });
    } else {
      const plugin = await ensureChannelPlugin(GUIDED_CHANNELS.slack.openclawId);
      if (!plugin.ok) installFailure = plugin.reason;
      try {
        await setSlackTokens(botToken, appToken);
      } catch (err) {
        if (err instanceof EnvSecretProviderConflictError) {
          // Nothing was written: the box's `secrets.providers.default` is
          // somebody else's, and a reference through it would never resolve.
          console.error(`[${LOG_TAG}] refusing an unresolvable token reference:`, err.message);
          return NextResponse.json({ success: false, code: "token_unresolved", restarted: false });
        }
        throw err;
      }
    }

    const restarted = await applyChannelRestart(harness, secrets, LOG_TAG);
    const blocking = await settleChannelSave(harness, "slack", restarted, installFailure);

    return NextResponse.json({
      success: blocking === undefined,
      ...(blocking === undefined ? {} : { code: blocking }),
      restarted,
      team: bot.teamName,
      botName: bot.botName,
    });
  } catch (err) {
    // Never echo a harness/CLI error verbatim — it can quote its argv.
    console.error(`[${LOG_TAG}] failed:`, scrubSecrets(err, secrets));
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
