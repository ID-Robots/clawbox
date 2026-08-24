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

export const dynamic = "force-dynamic";

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
  gateway: { installed: boolean; running: boolean };
  snapshot: HermesGatewaySnapshot;
  access: HermesDiscordAccess;
}

const HERMES_PROBE_TTL = 15_000;
let cachedHermesProbe: { token: string; probe: HermesDiscordProbe; at: number } | null = null;
const inFlightHermesProbe = new Map<string, Promise<HermesDiscordProbe>>();

async function probeHermes(token: string): Promise<HermesDiscordProbe> {
  if (
    cachedHermesProbe &&
    cachedHermesProbe.token === token &&
    Date.now() - cachedHermesProbe.at < HERMES_PROBE_TTL
  ) {
    return cachedHermesProbe.probe;
  }
  const existing = inFlightHermesProbe.get(token);
  if (existing) return existing;
  const pending = (async () => {
    // The snapshot and the env are plain file reads and cost nothing; only
    // `hermes gateway status` and `send --list` shell out, and they are what
    // this cache is for.
    const [registered, gateway, snapshot, access] = await Promise.all([
      hermesDiscordRegistered(),
      hermesGatewayStatus(),
      readHermesGatewaySnapshot(),
      readHermesDiscordAccess(),
    ]);
    const probe: HermesDiscordProbe = { registered, gateway, snapshot, access };
    cachedHermesProbe = { token, probe, at: Date.now() };
    return probe;
  })().finally(() => {
    inFlightHermesProbe.delete(token);
  });
  inFlightHermesProbe.set(token, pending);
  return pending;
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
        receiving: state === "connected",
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

    return NextResponse.json({
      configured: true,
      // OpenClaw gates Discord through its own owner-approved DM pairing and
      // exposes no per-platform state file, so there is nothing here that could
      // honestly be mapped to the four states.
      state: null,
      allowlistSupported: false,
      tokenRejected: bot.rejected,
      username: bot.info?.displayName,
      botId: bot.info?.id,
    });
  } catch (err) {
    console.error("[discord/status] failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}
