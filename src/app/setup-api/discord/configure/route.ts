import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  DiscordAuthError,
  type DiscordBotInfo,
  type DiscordGuildMembers,
  type DiscordIntents,
  DiscordUnavailableError,
  fetchDiscordBotInfo,
  fetchDiscordGuildMembers,
  fetchDiscordIntents,
  isSafeDiscordToken,
} from "@/lib/discord-api";
import { setDiscordToken, restartGateway } from "@/lib/openclaw-config";
import {
  type ChannelPluginFailure,
  type ChannelStatus,
  ensureChannelPlugin,
  waitForChannelConnected,
} from "@/lib/openclaw-channels";
import {
  DiscordEmptyAllowlistError,
  ensureHermesGateway,
  normalizeDiscordUserId,
  setHermesDiscordAllowlist,
  setHermesDiscordToken,
} from "@/lib/hermes-discord";

export const dynamic = "force-dynamic";

/** Where the two steps that fix a silent bot actually live. */
const DEVELOPER_PORTAL_URL = "https://discord.com/developers/applications";

// Guard rail, not policy: a caller can select at most this many people, so a
// pasted member dump cannot turn into a multi-kilobyte .env line.
const MAX_ALLOWED_USERS = 64;

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

// Deliberately different from the Telegram route in two places, both of them
// paid for in support time:
//
// 1. The token is verified against Discord BEFORE anything is written. Telegram
//    can validate offline (its token embeds the bot id, so a typo is a shape
//    error). A Discord token is opaque, so a save that skipped the live check
//    would report success for a token that can never log in.
//
// 2. The two things that make a *valid* token useless are checked here too,
//    because neither is visible from the token and both were hit live:
//
//    * MESSAGE CONTENT was never enabled in the Developer Portal, so the
//      gateway raises PrivilegedIntentsRequired and the bot is online and
//      deaf. Read from `GET /applications/@me` before saving.
//    * No allowlist exists, so the adapter denies every message it receives.
//      Fixed by writing DISCORD_ALLOWED_USERS as part of the same save, with
//      the guild owner selected by default.
//
// Both used to be discoverable only by reading the gateway log.

interface ConfigureBody {
  botToken?: unknown;
  /** Numeric member ids from the picker. Absent on a first save. */
  allowedUserIds?: unknown;
}

// Shape AND format, up front, because the write order downstream makes a late
// rejection expensive: on the full-save path the token is stored and handed to
// the harness BEFORE the allowlist is applied, so a bad id discovered inside
// setHermesDiscordAllowlist surfaces as a 500 for a save that already half
// happened. Same normaliser the writer uses, so the two cannot drift apart.
function readUserIds(value: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "allowedUserIds must be an array" };
  if (value.length > MAX_ALLOWED_USERS) {
    return { error: `At most ${MAX_ALLOWED_USERS} people can be selected` };
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { error: "allowedUserIds must be strings" };
    const id = normalizeDiscordUserId(entry);
    // Rejected, never dropped: silently discarding one id would save an
    // allowlist that quietly excludes somebody the owner believes they added.
    if (!id) return { error: "Invalid Discord user id" };
    ids.push(id);
  }
  return { ids };
}

/** Members the picker offers, plus the ids selected by default. */
function defaultSelection(directory: DiscordGuildMembers): string[] {
  // The guild owner is who set the bot up, and was the id that fixed this by
  // hand. `owner_id` comes from GET /guilds/{id}, which needs no privileged
  // intent, so this default survives a bot whose Server Members intent is off.
  return directory.members.filter((m) => m.isOwner).map((m) => m.id);
}

async function applyAllowlist(
  harness: string,
  userIds: string[],
): Promise<{ allowedUsers: string[]; changedKeys: string[]; warning?: string }> {
  // The env allowlist is a Hermes mechanism. OpenClaw gates Discord through its
  // own owner-approved DM pairing, which ClawBox does not write, so there is
  // nothing honest to set there.
  if (harness !== "hermes") return { allowedUsers: [], changedKeys: [] };
  try {
    const result = await setHermesDiscordAllowlist(userIds);
    return { allowedUsers: result.allowedUsers, changedKeys: result.changedKeys };
  } catch (err) {
    if (err instanceof DiscordEmptyAllowlistError) {
      // Reached on a first save when the bot has not been invited to a server
      // yet, so there is no owner to select. Never silent: the caller turns
      // this into the panel's blocking warning state.
      return { allowedUsers: [], changedKeys: [], warning: "no_allowed_users" };
    }
    throw err;
  }
}

/** OpenClaw's id for this channel — the plugin's, the config key's and the CLI's. */
const DISCORD_CHANNEL_ID = "discord";

/**
 * How many times to ask the gateway whether the channel came up, and how long
 * to wait between asks.
 *
 * Each probe pays OpenClaw's CLI cold start (~10-12 s on a Jetson), so this is
 * a wall-clock budget of roughly a minute — enough for a gateway restarted a
 * moment ago to finish booting and log the channel in, and short enough that a
 * save still answers while the owner is looking at it.
 */
const CHANNEL_VERIFY_ATTEMPTS = 5;
const CHANNEL_VERIFY_DELAY_MS = 3_000;

/**
 * Warnings this route can return, beyond the allowlist/member ones that predate
 * it. The first three are BLOCKING: they mean the channel is not reachable, and
 * the save does not get to call itself a success.
 */
type ChannelWarning =
  | "plugin_install_failed"
  | "plugin_install_timeout"
  | "token_unresolved"
  | "channel_unverified"
  | "not_connected";

function pluginWarning(reason: ChannelPluginFailure): ChannelWarning {
  // "unsupported_channel" cannot be reached from here — Discord is in the
  // official-plugin map — but folding it in keeps the mapping total rather than
  // leaving a hole a future channel falls through.
  return reason === "install_timeout" ? "plugin_install_timeout" : "plugin_install_failed";
}

/**
 * What the gateway's own view of the channel says, worst-first.
 *
 * `null` from the probe is UNKNOWN, not "fine": a wedged CLI and a healthy
 * channel are not the same answer, and reporting the second for the first is
 * the dishonesty this whole path exists to remove.
 */
function channelWarning(status: ChannelStatus | null): ChannelWarning | undefined {
  if (!status) return "channel_unverified";
  if (status.tokenStatus === "configured_unavailable") return "token_unresolved";
  if (!status.connected) return "not_connected";
  return undefined;
}

/** Restart the harness' gateway; report rather than throw when it will not. */
async function applyRestart(harness: string, signal: AbortSignal, secret: string): Promise<boolean> {
  try {
    if (harness === "hermes") {
      const status = await ensureHermesGateway(signal);
      // A refused restart leaves the previous process up, and the unprivileged
      // status probe cannot tell the two apart — so require both.
      return status.running && status.applied;
    }
    await restartGateway();
    return true;
  } catch (err) {
    // The credential and the allowlist are already persisted, so a service
    // failure is a warning, not a failed save — the same contract
    // /telegram/configure has always had.
    console.error("[discord/configure] gateway restart failed:", scrub(err, secret));
    return false;
  }
}

export async function POST(request: Request) {
  // Kept out of the try so the outer catch can scrub it from anything it logs.
  let tokenForScrub = "";
  try {
    let body: ConfigureBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const harness = await getActiveHarness();

    let requestedIds: string[] | undefined;
    if (body.allowedUserIds !== undefined) {
      const parsed = readUserIds(body.allowedUserIds);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
      requestedIds = parsed.ids;
    }

    const rawToken = typeof body.botToken === "string" ? body.botToken.trim() : "";

    // ── Allowlist-only save: the picker changed, the token did not ──────────
    if (!rawToken) {
      if (requestedIds === undefined) {
        return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
      }
      if (harness !== "hermes") {
        return NextResponse.json(
          { error: "Discord access is managed by OpenClaw's own pairing", supported: false },
          { status: 501 },
        );
      }
      const stored = await get("discord_bot_token");
      if (!stored || typeof stored !== "string") {
        return NextResponse.json({ error: "Bot token is required" }, { status: 400 });
      }

      let result;
      try {
        result = await setHermesDiscordAllowlist(requestedIds);
      } catch (err) {
        if (err instanceof DiscordEmptyAllowlistError) {
          // The one refusal in this route. Everything else degrades to a
          // warning; this does not, because saving it would hand back a bot
          // that looks configured and answers nobody — the state this change
          // exists to remove.
          return NextResponse.json(
            { error: "empty_allowlist", code: "empty_allowlist" },
            { status: 400 },
          );
        }
        if (err instanceof Error && err.message === "Invalid Discord user id") {
          return NextResponse.json({ error: "Invalid Discord user id" }, { status: 400 });
        }
        throw err;
      }

      // Hermes' own convention for this operation: log which keys moved, never
      // what they were set to. The repo is public and these lines end up in
      // support bundles.
      if (result.changedKeys.length > 0) {
        console.info("[discord/configure] updated env keys:", result.changedKeys.join(","));
      }
      if (result.changedKeys.length === 0) {
        return NextResponse.json({
          success: true,
          restarted: false,
          unchanged: true,
          allowedUserIds: result.allowedUsers,
        });
      }

      const restarted = await applyRestart(harness, request.signal, "");
      return NextResponse.json({
        success: true,
        restarted,
        allowedUserIds: result.allowedUsers,
        warning: restarted ? undefined : "restart_pending",
      });
    }

    // ── Full save: token, intents preflight, members, allowlist ─────────────
    tokenForScrub = rawToken;
    // Cheap safety guard only (charset/length) — see isSafeDiscordToken. The
    // real verdict comes from Discord below.
    if (!isSafeDiscordToken(rawToken)) {
      return NextResponse.json({ error: "Invalid bot token format" }, { status: 400 });
    }

    let bot: DiscordBotInfo;
    try {
      bot = await fetchDiscordBotInfo(rawToken, request.signal);
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

    // Intents preflight. `null` means we could not read them — treated as
    // "unknown" and never as "they are off", because blocking a save on a
    // network blip is the same dishonesty pointing the other way.
    let intents: DiscordIntents | null = null;
    try {
      intents = await fetchDiscordIntents(rawToken, request.signal);
    } catch (err) {
      if (err instanceof DiscordAuthError) throw err;
    }

    if (intents && !intents.messageContent) {
      // Nothing is written. Saving here would produce the exact state this
      // preflight exists to prevent: a stored token, a panel that says
      // "receiving", and a gateway that cannot connect at all.
      return NextResponse.json(
        {
          error: "intents_missing",
          code: "intents_missing",
          missingIntents: [
            "MESSAGE CONTENT INTENT",
            ...(intents.serverMembers ? [] : ["SERVER MEMBERS INTENT"]),
          ],
          portalUrl: DEVELOPER_PORTAL_URL,
        },
        { status: 400 },
      );
    }

    // Who is in the servers this bot was invited to. A failure here is soft:
    // the token is good, and refusing to save it because a member list could
    // not be read would be worse than saving it without a picker.
    let directory: DiscordGuildMembers | null = null;
    try {
      directory = await fetchDiscordGuildMembers(rawToken, request.signal);
    } catch (err) {
      if (err instanceof DiscordAuthError) throw err;
    }

    // ClawBox's own store is written first, so a harness failure below can
    // never lose the credential the user just pasted.
    await set("discord_bot_token", rawToken);

    // OpenClaw ships NO Discord channel in its stock extensions — the gateway
    // logs "no channel plugin is installed or loadable (no-channel-owner)" and
    // carries on. Installing the official plugin is part of saving the channel,
    // and it has to happen BEFORE setDiscordToken: `plugins install` writes
    // plugins.entries.discord into the same openclaw.json that the channel
    // write read-modify-writes, so the other order drops the enable.
    let installFailure: ChannelPluginFailure | null = null;
    if (harness !== "hermes") {
      const plugin = await ensureChannelPlugin(DISCORD_CHANNEL_ID);
      if (!plugin.ok) installFailure = plugin.reason;
    }

    if (harness === "hermes") {
      await setHermesDiscordToken(rawToken, request.signal);
    } else {
      // OpenClaw: channel config + the EnvironmentFile the gateway resolves
      // `channels.discord.token` from.
      await setDiscordToken(rawToken);
    }

    const selection = requestedIds ?? (directory ? defaultSelection(directory) : []);
    const allowlist = await applyAllowlist(harness, selection);
    if (allowlist.changedKeys.length > 0) {
      console.info("[discord/configure] updated env keys:", allowlist.changedKeys.join(","));
    }

    const restarted = await applyRestart(harness, request.signal, rawToken);

    // ── Did the channel actually come up? ──────────────────────────────────
    //
    // Everything above this line is a WRITE. A save that stops there is exactly
    // the report that hid both defects for weeks: the credential was stored,
    // the gateway was bounced, `{success:true}` went back, and the bot was in a
    // restart loop the whole time. So ask the gateway.
    //
    // Only on OpenClaw: Hermes has no `openclaw` binary to ask, and its own
    // /discord/status probe already maps that harness' four states.
    let liveStatus: ChannelStatus | null = null;
    if (harness !== "hermes" && restarted) {
      liveStatus = await waitForChannelConnected(DISCORD_CHANNEL_ID, {
        attempts: CHANNEL_VERIFY_ATTEMPTS,
        delayMs: CHANNEL_VERIFY_DELAY_MS,
      });
    }

    // Root cause first: a plugin that never installed explains every state
    // below it, and "restart pending" explains a channel that is not up. Only
    // when both of those are fine is the gateway's own verdict the answer.
    const blocking: ChannelWarning | "restart_pending" | undefined =
      harness === "hermes"
        ? !restarted
          ? "restart_pending"
          : undefined
        : installFailure
          ? pluginWarning(installFailure)
          : !restarted
            ? "restart_pending"
            : channelWarning(liveStatus);

    // Warning precedence: a bot nobody may talk to is a bigger problem than a
    // channel that has not come up, and a missing member list is the least of
    // them.
    const warning =
      allowlist.warning ??
      blocking ??
      (directory === null ? "members_unavailable" : undefined) ??
      (intents && !intents.serverMembers ? "server_members_intent" : undefined);

    // `success` means the channel is REACHABLE, not "the files were written".
    // The Hermes leg keeps its older contract: it has its own live status probe
    // and no CLI here to ask, so a restart it could not apply stays a warning.
    const success = harness === "hermes" || blocking === undefined;

    return NextResponse.json({
      success,
      // A machine-readable reason for the client to translate. Blocking only —
      // `warning` still carries the advisory ones.
      ...(success ? {} : { code: blocking }),
      restarted,
      username: bot.displayName,
      botId: bot.id,
      intents,
      guilds: directory?.guilds ?? [],
      members: directory?.members ?? [],
      allowedUserIds: allowlist.allowedUsers,
      allowlistSupported: harness === "hermes",
      portalUrl: DEVELOPER_PORTAL_URL,
      warning,
    });
  } catch (err) {
    // Never echo a harness/CLI error verbatim — those can quote the argv they
    // were handed, which is where the token is.
    console.error("[discord/configure] failed:", scrub(err, tokenForScrub));
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
