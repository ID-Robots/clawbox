import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";

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

export async function GET() {
  try {
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
