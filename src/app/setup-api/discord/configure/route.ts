import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  DiscordAuthError,
  type DiscordBotInfo,
  DiscordUnavailableError,
  fetchDiscordBotInfo,
  isSafeDiscordToken,
} from "@/lib/discord-api";
import { setDiscordToken, restartGateway } from "@/lib/openclaw-config";
import { ensureHermesGateway, setHermesDiscordToken } from "@/lib/hermes-discord";

export const dynamic = "force-dynamic";

/**
 * Text of an error, with the bot token scrubbed out of it.
 *
 * Neither harness path is *supposed* to put the token in an error — OpenClaw's
 * spawn helper redacts argv values (configSetLabelArgs) and the Hermes wrapper
 * throws a fixed string. This is the backstop for the one that some day
 * forgets: a token in the journal is a live credential on disk (CWE-532), and
 * this repo is public.
 */
function scrub(err: unknown, secret: string): string {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return secret ? text.split(secret).join("<redacted>") : text;
}

// Deliberately different from the Telegram route in one place: the token is
// verified against Discord BEFORE anything is written.
//
// Telegram can validate offline (its token embeds the bot id, so a typo is a
// shape error) and leaves liveness to the status route. A Discord token is
// opaque — a regex cannot tell a real one from a plausible-looking string — so
// a save that skipped the live check would report success for a token that can
// never log in, and the only symptom would be a bot that is "configured" and
// permanently silent. That is exactly the failure this integration exists to
// avoid, so an unverifiable token is not saved at all.

export async function POST(request: Request) {
  // Kept out of the try so the outer catch can scrub it from anything it logs.
  let tokenForScrub = "";
  try {
    let body: { botToken?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    if (!botToken) {
      return NextResponse.json({ error: "Bot token is required" }, { status: 400 });
    }
    // Cheap safety guard only (charset/length) — see isSafeDiscordToken. The
    // real verdict comes from Discord below.
    tokenForScrub = botToken;
    if (!isSafeDiscordToken(botToken)) {
      return NextResponse.json({ error: "Invalid bot token format" }, { status: 400 });
    }

    let bot: DiscordBotInfo;
    try {
      bot = await fetchDiscordBotInfo(botToken, request.signal);
    } catch (err) {
      if (err instanceof DiscordAuthError) {
        return NextResponse.json(
          {
            error:
              "Discord rejected this bot token. Copy it again from the Bot page of your application — a token is shown only once, so an old copy stops working after a reset.",
          },
          { status: 400 },
        );
      }
      if (err instanceof DiscordUnavailableError) {
        return NextResponse.json(
          {
            error:
              "Couldn't reach Discord to check the token. Make sure the device is online, then try again.",
          },
          { status: 502 },
        );
      }
      throw err;
    }

    // ClawBox's own store is written first, so a harness failure below can
    // never lose the credential the user just pasted.
    await set("discord_bot_token", botToken);

    const harness = await getActiveHarness();

    if (harness === "hermes") {
      await setHermesDiscordToken(botToken, request.signal);

      // Hermes' messaging gateway is the process that RECEIVES messages, so it
      // has to be installed and up. The token is already persisted here — a
      // service failure is a warning, not a failed save.
      try {
        const status = await ensureHermesGateway(request.signal);
        if (!status.running) {
          return NextResponse.json({
            success: true,
            restarted: false,
            username: bot.displayName,
            warning: "Saved — will apply on next gateway restart",
          });
        }
      } catch (gatewayErr) {
        console.error("[discord/configure] Hermes gateway start failed:", scrub(gatewayErr, botToken));
        return NextResponse.json({
          success: true,
          restarted: false,
          username: bot.displayName,
          warning: "Saved — will apply on next gateway restart",
        });
      }

      return NextResponse.json({ success: true, restarted: true, username: bot.displayName });
    }

    // OpenClaw: channel config + the EnvironmentFile the gateway resolves
    // `channels.discord.token` from.
    await setDiscordToken(botToken);

    try {
      await restartGateway();
    } catch (restartErr) {
      // Same soft-warning contract as /telegram/configure: the token is already
      // persisted, so a restart failure must not fail the save, and the raw
      // exec error is logged rather than returned.
      console.error("[discord/configure] Gateway restart failed:", scrub(restartErr, botToken));
      return NextResponse.json({
        success: true,
        restarted: false,
        username: bot.displayName,
        warning: "Saved — will apply on next gateway restart",
      });
    }

    return NextResponse.json({ success: true, restarted: true, username: bot.displayName });
  } catch (err) {
    // Never echo a harness/CLI error verbatim — those can quote the argv they
    // were handed, which is where the token is. `botToken` is out of scope in
    // this outer catch (the body may not even have parsed), so re-read it
    // defensively before scrubbing.
    console.error("[discord/configure] failed:", scrub(err, tokenForScrub));
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
