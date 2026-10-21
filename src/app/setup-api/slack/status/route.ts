import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { SlackAuthError, type SlackBotInfo, fetchSlackBotInfo } from "@/lib/slack-api";
import { readGuidedChannelStatus } from "@/lib/guided-channels";

export const dynamic = "force-dynamic";

// Caching mirrors /discord/status: the hub row and the pane both read this, so
// Slack's `auth.test` is asked at most once a minute per token (5 s after a
// failure, so a box that just came back online recovers quickly), and
// concurrent callers share one request.
const BOT_INFO_CACHE_TTL = 60_000;
const BOT_INFO_FAIL_CACHE_TTL = 5_000;

interface BotProbe {
  info: SlackBotInfo | null;
  /** True only when Slack itself said the token is dead. */
  rejected: boolean;
}

let cachedProbe: { token: string; probe: BotProbe; at: number } | null = null;
let lastFailure: { token: string; at: number } | null = null;
const inFlight = new Map<string, Promise<BotProbe>>();

async function probeBotFresh(token: string): Promise<BotProbe> {
  try {
    const info = await fetchSlackBotInfo(token);
    const probe: BotProbe = { info, rejected: false };
    cachedProbe = { token, probe, at: Date.now() };
    lastFailure = null;
    return probe;
  } catch (err) {
    if (err instanceof SlackAuthError) {
      // A definite answer, worth caching like a success: the stored token is
      // dead until the owner pastes a new one.
      const probe: BotProbe = { info: null, rejected: true };
      cachedProbe = { token, probe, at: Date.now() };
      return probe;
    }
    // Offline, rate-limited, 5xx — says nothing about the token.
    lastFailure = { token, at: Date.now() };
    return { info: null, rejected: false };
  }
}

function probeBot(token: string): Promise<BotProbe> {
  const now = Date.now();
  if (cachedProbe && cachedProbe.token === token && now - cachedProbe.at < BOT_INFO_CACHE_TTL) {
    return Promise.resolve(cachedProbe.probe);
  }
  if (lastFailure && lastFailure.token === token && now - lastFailure.at < BOT_INFO_FAIL_CACHE_TTL) {
    return Promise.resolve({ info: null, rejected: false });
  }
  const existing = inFlight.get(token);
  if (existing) return existing;
  const pending = probeBotFresh(token).finally(() => inFlight.delete(token));
  inFlight.set(token, pending);
  return pending;
}

export async function GET() {
  try {
    const token = await get("slack_bot_token");
    if (!token || typeof token !== "string") {
      return NextResponse.json({ configured: false });
    }
    const harness = await getActiveHarness();
    const [bot, live] = await Promise.all([probeBot(token), readGuidedChannelStatus(harness, "slack")]);
    return NextResponse.json({
      ...live,
      // Slack's own answer is the only source for the names: the gateway row
      // carries no workspace identity without a probe that is itself a call to
      // Slack.
      tokenRejected: bot.rejected,
      team: bot.info?.teamName ?? null,
      botName: bot.info?.botName ?? null,
    });
  } catch (err) {
    console.error("[slack/status] failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}
