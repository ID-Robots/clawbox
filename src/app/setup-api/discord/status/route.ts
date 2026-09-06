import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  DiscordAuthError,
  type DiscordBotInfo,
  fetchDiscordBotInfo,
} from "@/lib/discord-api";
import {
  DISCORD_AUTH_ERROR_CODE,
  type DiscordConnectionState,
  type HermesDiscordAccess,
  type HermesGatewaySnapshot,
  hermesDiscordRegistered,
  hermesGatewayStatus,
  mapDiscordConnectionState,
  readHermesDiscordAccess,
  readHermesGatewaySnapshot,
} from "@/lib/hermes-discord";
import { type ChannelStatus, readCachedChannelStatus } from "@/lib/openclaw-channels";

export const dynamic = "force-dynamic";

/** OpenClaw's id for this channel — the config key's, the plugin's, the CLI's. */
const DISCORD_CHANNEL_ID = "discord";

// Discord refuses a gateway connection outright when a privileged intent the
// bot asked for was never enabled in the Developer Portal. The gateway records
// that refusal verbatim, and it is the one failure with a remedy the panel can
// name, so it gets its own state rather than being flattened into "offline".
const DISALLOWED_INTENTS_RE = /disallowed\s*intents|privileged\s*intent/i;

/**
 * Map an OpenClaw channel row onto the SAME four states the Hermes branch uses.
 *
 * Deliberately not a second vocabulary: one card renders these, and two
 * meanings behind one word is how "connected" stopped meaning connected.
 *
 * Order is the argument, mirroring mapDiscordConnectionState():
 *   * nothing is connected while the adapter is not running, so that is checked
 *     before any recorded error;
 *   * an intents refusal outranks the transport's own word once it IS running,
 *     because the adapter will never retry out of it and it is what the owner
 *     has to act on;
 *   * `connected` requires the transport to actually be up. `running` alone was
 *     satisfied by a process in a restart loop.
 *
 * "denied-no-allowlist" is unreachable here on purpose: OpenClaw admits senders
 * through its own owner-approved DM pairing, which ClawBox neither writes nor
 * reads, so there is no allowlist whose emptiness this could honestly report.
 */
export function mapOpenclawChannelState(status: ChannelStatus): DiscordConnectionState {
  if (status.lastError && DISALLOWED_INTENTS_RE.test(status.lastError) && status.running) {
    return "intents-missing";
  }
  if (!status.running) return "offline";
  if (status.connected) return "connected";
  return "offline";
}

// Caching mirrors /telegram/status, and for the same reason: the Settings panel
// and the section subtitle both read this, so a naive implementation would hit
// Discord on every panel open and every re-render.
//   * 60 s success cache — the bot's name does not change often.
//   * 5 s failure cache — a device that just went offline must not retry per
//     request, but must recover quickly once it is back.
//   * in-flight coalescing — concurrent callers share one request.
const BOT_INFO_CACHE_TTL = 60_000;
const BOT_INFO_FAIL_CACHE_TTL = 5_000;

interface BotProbe {
  info: DiscordBotInfo | null;
  /** true only when Discord itself said the token is invalid (401). */
  rejected: boolean;
}

let cachedBotInfo: { token: string; probe: BotProbe; at: number } | null = null;
let lastFailureAt: { token: string; at: number } | null = null;
const inFlightFetch = new Map<string, Promise<BotProbe>>();

async function fetchBotProbeFresh(token: string): Promise<BotProbe> {
  try {
    const info = await fetchDiscordBotInfo(token);
    const probe: BotProbe = { info, rejected: false };
    cachedBotInfo = { token, probe, at: Date.now() };
    lastFailureAt = null;
    return probe;
  } catch (err) {
    if (err instanceof DiscordAuthError) {
      // A definite answer, so it is worth caching like a success: the token on
      // disk is dead until the owner pastes a new one.
      const probe: BotProbe = { info: null, rejected: true };
      cachedBotInfo = { token, probe, at: Date.now() };
      return probe;
    }
    // Offline / rate-limited / 5xx — says nothing about the token.
    lastFailureAt = { token, at: Date.now() };
    return { info: null, rejected: false };
  }
}

async function fetchBotProbe(token: string): Promise<BotProbe> {
  if (cachedBotInfo && cachedBotInfo.token === token && Date.now() - cachedBotInfo.at < BOT_INFO_CACHE_TTL) {
    return cachedBotInfo.probe;
  }
  if (lastFailureAt && lastFailureAt.token === token && Date.now() - lastFailureAt.at < BOT_INFO_FAIL_CACHE_TTL) {
    return { info: null, rejected: false };
  }
  const existing = inFlightFetch.get(token);
  if (existing) return existing;
  const pending = fetchBotProbeFresh(token).finally(() => {
    inFlightFetch.delete(token);
  });
  inFlightFetch.set(token, pending);
  return pending;
}

// ── Hermes: ask Hermes, don't just report that a token is stored ────────────

interface HermesDiscordProbe {
  registered: boolean | null;
  gateway: { installed: boolean; running: boolean; answered?: boolean };
  snapshot: HermesGatewaySnapshot;
  access: HermesDiscordAccess;
}

const HERMES_PROBE_TTL = 15_000;
// A probe that could NOT be answered is remembered too, but briefly. `null`
// means Hermes could not be asked, and caching that for the full success window
// makes the panel's Retry a dead press for fifteen seconds — the very control
// an unreadable row now offers. Same success/failure split as the shared
// gateway memo in `hermes-telegram.ts`.
const HERMES_PROBE_FAILURE_TTL = 3_000;
// ONLY `send --list discord` is memoised here — the same shape the Telegram
// status route uses.
//
// The GATEWAY half is not: `hermesGatewayStatus()` owns one shared memo for the
// whole process, with its own failure TTL and an invalidation the restart paths
// call, and a second 15 s copy here would shadow both.
//
// The snapshot and the access env are not either, and their own comment is why:
// one `fs.readFile` and one `readHermesEnv()` cost nothing, so caching them
// bought nothing and composed a FRESH `gateway.running` with a stale allowlist.
// The owner saved the Discord allowlist, the gateway restarted, and for up to
// 15 s afterwards this route still reported `denied-no-allowlist` — "every
// message is being dropped" — over the thing he had just fixed.
let cachedRegistered: { token: string; registered: boolean | null; at: number } | null = null;
const inFlightRegistered = new Map<string, Promise<boolean | null>>();

function probeRegistered(token: string): Promise<boolean | null> {
  if (
    cachedRegistered &&
    cachedRegistered.token === token &&
    Date.now() - cachedRegistered.at
      < (cachedRegistered.registered === null ? HERMES_PROBE_FAILURE_TTL : HERMES_PROBE_TTL)
  ) {
    return Promise.resolve(cachedRegistered.registered);
  }
  const existing = inFlightRegistered.get(token);
  if (existing) return existing;
  const pending = (async () => {
    const registered = await hermesDiscordRegistered();
    cachedRegistered = { token, registered, at: Date.now() };
    return registered;
  })().finally(() => {
    inFlightRegistered.delete(token);
  });
  inFlightRegistered.set(token, pending);
  return pending;
}

async function probeHermes(token: string): Promise<HermesDiscordProbe> {
  const [registered, gateway, snapshot, access] = await Promise.all([
    probeRegistered(token),
    hermesGatewayStatus(),
    readHermesGatewaySnapshot(),
    readHermesDiscordAccess(),
  ]);
  return { registered, gateway, snapshot, access };
}

export async function GET() {
  try {
    const token = await get("discord_bot_token");
    if (!token || typeof token !== "string") {
      return NextResponse.json({ configured: false });
    }

    const bot = await fetchBotProbe(token);

    if ((await getActiveHarness()) === "hermes") {
      const { registered, gateway, snapshot, access } = await probeHermes(token);
      // `null` = Hermes couldn't be asked; fall back to the stored token rather
      // than reporting a working bot as gone.
      const configured = registered ?? true;

      // The honest question is not "is a token stored and is a process up" —
      // both were true on the bench box while Discord refused to connect and
      // then, once connected, dropped every message. It is "what does the
      // gateway say about the Discord platform, and will the adapter admit
      // anyone". mapDiscordConnectionState answers exactly that.
      const observed = mapDiscordConnectionState({
        gatewayRunning: gateway.running,
        snapshot,
        authorized: access.authorized,
      });
      // Hermes saying it has no Discord platform at all outranks anything a
      // leftover snapshot claims about one.
      const state: DiscordConnectionState = configured ? observed : "offline";

      return NextResponse.json({
        configured,
        // Whether the answer came from Hermes or from the stored token alone.
        verified: registered !== null,
        state,
        // "receiving" may be true ONLY when Discord is genuinely connected AND
        // somebody is allowed to talk to it. It used to be
        // `configured && gateway.running`, which is why a bot that could not
        // connect at all was reported as live.
        //
        // `null` when Hermes could not be ASKED: a failed gateway probe comes
        // back as `running: false`, `mapDiscordConnectionState` has no unknown
        // member and answers "offline" on it, and a panel that draws a dot from
        // this field would then accuse a healthy bot.
        receiving: gateway.answered === false ? null : state === "connected",
        // Discord itself said the stored token is dead — the one state the UI
        // must surface even while everything else looks configured.
        tokenRejected: bot.rejected || snapshot.platform?.errorCode === DISCORD_AUTH_ERROR_CODE,
        gateway,
        // The gateway's own word for the platform, so a state nobody
        // anticipated is still visible rather than flattened into "offline".
        platformState: snapshot.platform?.state ?? null,
        platformErrorCode: snapshot.platform?.errorCode ?? null,
        allowedUserIds: access.allowedUsers,
        allowlistExtras: access.allowlistExtras,
        allowAllUsers: access.allowAllUsers,
        authorized: access.authorized,
        allowlistSupported: true,
        username: bot.info?.displayName,
        botId: bot.info?.id,
      });
    }

    // ── OpenClaw ───────────────────────────────────────────────────────────
    //
    // This branch used to answer `state: null`, on the reasoning that OpenClaw
    // "exposes no per-platform state file". That was true when it was written
    // and is not true of openclaw 2026.7.x: `openclaw channels status --json`
    // publishes a per-account row carrying `running`, `connected`,
    // `tokenStatus` and `lastError`, which is exactly the vocabulary the Hermes
    // branch above maps. So the card was blank on a box whose bot was
    // answering in Discord.
    // Through the shared memo in openclaw-channels: ONE CLI cold start per
    // window for every channel at once (the read is un-filtered, TASK-671),
    // concurrent callers coalesced, failures remembered too. This route used to hold a private copy of that cache — which is why
    // /whatsapp/status, reading the same command with no memo at all, cost 3.6 s
    // a poll where this one cost 20 ms.
    const channel = await readCachedChannelStatus(DISCORD_CHANNEL_ID);
    // `null` = the gateway could not be asked (CLI timeout, gateway restarting,
    // no openclaw binary). UNKNOWN, which the panel renders as its neutral
    // state — never "offline", which would accuse a healthy bot, and never
    // "connected", which is the lie this file exists to prevent.
    const state = channel ? mapOpenclawChannelState(channel) : null;

    return NextResponse.json({
      configured: true,
      // Whether the answer came from the gateway or from the stored token alone
      // — the same field, with the same meaning, as the Hermes branch.
      verified: channel !== null,
      state,
      // Same rule as Hermes, and it is the rule that matters: "receiving" may
      // be true ONLY when the transport is genuinely up — and `null`, never
      // false, when `state` is null. That null is documented four lines up as
      // UNKNOWN, and flattening it here is how a gateway restart (every Save
      // triggers one) painted "set up, but not receiving" over a Discord bot
      // that was answering in a guild.
      receiving: state === null ? null : state === "connected",
      // OpenClaw gates who may talk to the bot through its own owner-approved
      // DM pairing, which ClawBox does not write — so there is no allowlist to
      // offer here and no "denied" state to report.
      allowlistSupported: false,
      tokenRejected: bot.rejected,
      // Discord's own answer is the ONLY source for the display name. The
      // gateway's account row carries no bot identity unless `channels status`
      // is given `--probe`, and that probe is itself a call to Discord — so on
      // a device that cannot reach Discord there is no second opinion to fall
      // back to. See readChannelRow() for why we do not pay for `--probe`.
      username: bot.info?.displayName,
      botId: bot.info?.id,
    });
  } catch (err) {
    console.error("[discord/status] failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}
