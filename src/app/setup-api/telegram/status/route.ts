import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { hermesGatewayStatus, hermesTelegramRegistered } from "@/lib/hermes-telegram";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";

export const dynamic = "force-dynamic";

interface TelegramBotInfo {
  username?: string;
  firstName?: string;
  link?: string;
}

const BOT_INFO_CACHE_TTL = 60_000;
const BOT_INFO_FAIL_CACHE_TTL = 5_000;
let cachedBotInfo: { token: string; info: TelegramBotInfo; at: number } | null = null;
let lastFailureAt: { token: string; at: number } | null = null;
const inFlightFetch = new Map<string, Promise<TelegramBotInfo | null>>();

async function fetchBotInfoFresh(token: string): Promise<TelegramBotInfo | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data.result?.username) {
        const info: TelegramBotInfo = {
          username: data.result.username,
          firstName: data.result.first_name,
          link: `https://t.me/${data.result.username}`,
        };
        cachedBotInfo = { token, info, at: Date.now() };
        lastFailureAt = null;
        return info;
      }
    }
  } catch {
    // network or timeout — fall through to short-lived failure cache
  }
  lastFailureAt = { token, at: Date.now() };
  return null;
}

async function fetchBotInfo(token: string): Promise<TelegramBotInfo | null> {
  if (cachedBotInfo && cachedBotInfo.token === token && Date.now() - cachedBotInfo.at < BOT_INFO_CACHE_TTL) {
    return cachedBotInfo.info;
  }
  if (lastFailureAt && lastFailureAt.token === token && Date.now() - lastFailureAt.at < BOT_INFO_FAIL_CACHE_TTL) {
    return null;
  }
  // Coalesce concurrent callers for the same token onto a single in-flight
  // request so a cache miss can't trigger a thundering herd against Telegram.
  const existing = inFlightFetch.get(token);
  if (existing) return existing;
  const pending = fetchBotInfoFresh(token).finally(() => {
    inFlightFetch.delete(token);
  });
  inFlightFetch.set(token, pending);
  return pending;
}

// ── Hermes: ask Hermes, don't just report that a token is stored ────────────
//
// On a Hermes device a stored token proves nothing — the OpenClaw path used to
// save one on a box with no gateway to consume it, and the flag still read
// "configured" while the bot never answered. So the flag comes from Hermes
// itself. Both answers are CLI calls (~2 s each on a Jetson), so they run
// concurrently behind a short cache rather than serially on every panel open.

interface HermesTelegramProbe {
  registered: boolean | null;
  gateway: { installed: boolean; running: boolean };
}

const HERMES_PROBE_TTL = 15_000;
// A probe that could NOT be answered is remembered too, but briefly. `null`
// means Hermes could not be asked, and caching that for the full success window
// makes the panel's Retry a dead press for fifteen seconds — the very control
// an unreadable row now offers. Same success/failure split as the shared
// gateway memo in `hermes-telegram.ts`.
const HERMES_PROBE_FAILURE_TTL = 3_000;
// Keyed by token, like the bot-info cache above: saving a different bot must
// not be answered from the previous bot's probe for the next 15 seconds.
//
// The GATEWAY half is deliberately NOT in here. `hermesGatewayStatus()` owns
// one shared memo for the whole process, with its own failure TTL and an
// invalidation the restart paths call; a second 15 s copy here would shadow
// both, so a save that restarted the gateway kept being answered with the
// pre-restart process until this cache aged out on its own.
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
    const registered = await hermesTelegramRegistered();
    cachedRegistered = { token, registered, at: Date.now() };
    return registered;
  })().finally(() => {
    inFlightRegistered.delete(token);
  });
  inFlightRegistered.set(token, pending);
  return pending;
}

async function probeHermes(token: string): Promise<HermesTelegramProbe> {
  const [registered, gateway] = await Promise.all([
    probeRegistered(token),
    hermesGatewayStatus(),
  ]);
  return { registered, gateway };
}

export async function GET() {
  try {
    // WHICH EDITION FIRST. Reading ClawBox's own `telegram_bot_token` up here
    // made the Hermes branch below unreachable on exactly the boxes it was
    // written for: on Hermes the credential is the harness's, and ClawBox's
    // copy is written only as a side effect of /setup-api/telegram/configure,
    // so a box paired with `hermes config set` — or restored with ~/.hermes
    // intact but no ClawBox config.json — answered `configured: false` and the
    // owner was invited to set up the bot he was already chatting with.
    const harness = await getActiveHarness();

    if (harness === "hermes") {
      const { token } = await readActiveTelegramBot(harness);
      if (!token) return NextResponse.json({ configured: false });

      const { registered, gateway } = await probeHermes(token);
      // `null` = Hermes couldn't be asked; fall back to the token we found
      // rather than reporting a working bot as gone. Tied to `token` and not
      // written as a bare `true`, so the fallback carries its own reason: a
      // plain `true` is right only while the guard above stands, and this
      // branch's guard has already moved once.
      const configured = registered ?? Boolean(token);
      const info = configured ? await fetchBotInfo(token) : null;
      return NextResponse.json({
        configured,
        // Whether the answer came from Hermes or from the stored token alone.
        verified: registered !== null,
        // Telegram is only LIVE when something is listening for updates.
        receiving: configured && gateway.running,
        gateway,
        ...info,
      });
    }

    const token = await get("telegram_bot_token");
    if (!token || typeof token !== "string") {
      return NextResponse.json({ configured: false });
    }
    const info = await fetchBotInfo(token);
    return NextResponse.json({ configured: true, ...info });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
