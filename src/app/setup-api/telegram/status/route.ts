import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { hermesGatewayStatus, hermesTelegramRegistered } from "@/lib/hermes-telegram";
import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";
import { readCachedChannelStatus } from "@/lib/openclaw-channels";

export const dynamic = "force-dynamic";

/** The channel id `openclaw channels status` knows Telegram by. */
const TELEGRAM_CHANNEL_ID = "telegram";

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
  gateway: { installed: boolean; running: boolean; answered?: boolean };
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
      const { token, known } = await readActiveTelegramBot(harness);
      // `unknown` carries the third state out instead of collapsing it: a store
      // this box could not read must not render as a box with no bot, which is
      // the false failure the whole module exists to remove. Nothing draws it
      // yet — that needs a UI state and ten locales — but the fact belongs in
      // the response rather than only in the journal.
      if (!token) return NextResponse.json({ configured: false, unknown: !known });

      const { registered, gateway } = await probeHermes(token);
      // `null` = Hermes couldn't be asked; fall back to the token we found
      // rather than reporting a working bot as gone. `true` is correct here
      // only because the early return above has already established that a bot
      // token exists — before that guard was hoisted, this line could have
      // turned "could not ask" into "a bot is configured" on a box with none.
      const configured = registered ?? true;
      const info = configured ? await fetchBotInfo(token) : null;
      return NextResponse.json({
        configured,
        // Whether the answer came from Hermes or from the stored token alone.
        verified: registered !== null,
        // Telegram is only LIVE when something is listening for updates —
        // and `null` when the gateway could not be ASKED. A failed probe comes
        // back as `running: false` (the right shape for "may I start it?", the
        // wrong one for "is it up?"), and every Telegram save restarts the
        // gateway, so the read right after one lands inside that window: the
        // panel would have asserted "set up, but not receiving" over a box
        // that is fine, at exactly the moment the owner is watching it.
        receiving: gateway.answered === false ? null : configured && gateway.running,
        gateway,
        ...info,
      });
    }

    // Same reader, same reason: on OpenClaw the credential is
    // `channels.telegram.botToken` in openclaw.json — what `setTelegramToken()`
    // writes and what the gateway long-polls from — and ClawBox's copy is again
    // only a side effect of the configure route. A box paired with `openclaw
    // config set`, or restored with ~/.openclaw intact and a fresh
    // data/config.json, was told to set up the bot it already answers on.
    const { token, known } = await readActiveTelegramBot(harness);
    if (!token) return NextResponse.json({ configured: false, unknown: !known });
    // Whether anything is LISTENING, asked of the harness's own answer rather
    // than inferred: `openclaw channels status --channel telegram --json`
    // through the ONE shared memo `readCachedChannelStatus` owns (15 s success
    // / 3 s failure, in-flight coalesced, invalidated by every channel write) —
    // the same mechanism the Discord route one file over already uses, and the
    // reason this costs ~20 ms rather than a CLI boot.
    //
    // Without it this branch published no `receiving` at all, so the Channels
    // hub drew its emerald dot for a Telegram bot on a box whose gateway was
    // stopped — the false success this route exists to answer, on the edition
    // most boxes ship with.
    //
    // `null` is "the gateway could not be asked", NEVER "not receiving": a
    // panel that read a failed probe as a definite no would accuse a healthy
    // bot every time a save restarted the gateway.
    //
    // Paired with the bot lookup because the two are independent — one asks the
    // gateway, the other asks Telegram, and both need only the token. In series
    // a cold status probe delayed the lookup by its whole duration; the Hermes
    // branch above pairs its own two for the same reason (`probeHermes`).
    const [channel, info] = await Promise.all([
      readCachedChannelStatus(TELEGRAM_CHANNEL_ID),
      fetchBotInfo(token),
    ]);
    return NextResponse.json({
      configured: true,
      // The same field, with the same meaning, as the Hermes branch above.
      verified: channel !== null,
      receiving: channel === null ? null : channel.running && channel.connected,
      ...info,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
