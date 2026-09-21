import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  DiscordAuthError,
  type DiscordGuildMembers,
  fetchDiscordGuildMembers,
} from "@/lib/discord-api";
import { readHermesDiscordAccess } from "@/lib/hermes-discord";

export const dynamic = "force-dynamic";

// Why this is its own route rather than a field on /discord/status.
//
// The picker needs the guild member list, which costs 1 + 2N Discord calls.
// /discord/status is polled every time the Settings panel opens a section and
// backs the sidebar subtitle, so paying for a member fetch there would put
// those calls behind every poll. This route is only called when the Discord
// section is actually open and a bot is already configured.
//
// Same cache shape as the bot-info probe in /discord/status: a 60 s success
// cache, a 5 s failure cache so a device that just went offline does not retry
// per request, and in-flight coalescing so concurrent callers share one fetch.
const MEMBERS_CACHE_TTL = 60_000;
const MEMBERS_FAIL_CACHE_TTL = 5_000;

let cached: { token: string; value: DiscordGuildMembers; at: number } | null = null;
let lastFailure: { token: string; at: number } | null = null;
const inFlight = new Map<string, Promise<DiscordGuildMembers | null>>();

async function fetchFresh(token: string): Promise<DiscordGuildMembers | null> {
  try {
    const value = await fetchDiscordGuildMembers(token);
    cached = { token, value, at: Date.now() };
    lastFailure = null;
    return value;
  } catch (err) {
    lastFailure = { token, at: Date.now() };
    // A rejected token is /discord/status' story to tell — this route only
    // reports that it has no list.
    if (err instanceof DiscordAuthError) return null;
    return null;
  }
}

async function fetchMembers(token: string): Promise<DiscordGuildMembers | null> {
  if (cached && cached.token === token && Date.now() - cached.at < MEMBERS_CACHE_TTL) {
    return cached.value;
  }
  if (lastFailure && lastFailure.token === token && Date.now() - lastFailure.at < MEMBERS_FAIL_CACHE_TTL) {
    return null;
  }
  const existing = inFlight.get(token);
  if (existing) return existing;
  const pending = fetchFresh(token).finally(() => {
    inFlight.delete(token);
  });
  inFlight.set(token, pending);
  return pending;
}

export async function GET() {
  try {
    if ((await getActiveHarness()) !== "hermes") {
      // OpenClaw gates Discord through its own owner-approved DM pairing, which
      // ClawBox does not write, so there is no allowlist for a picker to edit.
      return NextResponse.json({ supported: false, members: [], guilds: [], allowedUserIds: [] });
    }

    const token = await get("discord_bot_token");
    if (!token || typeof token !== "string") {
      return NextResponse.json({ supported: true, configured: false, members: [], guilds: [], allowedUserIds: [] });
    }

    const [directory, access] = await Promise.all([fetchMembers(token), readHermesDiscordAccess()]);

    return NextResponse.json({
      supported: true,
      configured: true,
      // null means the list could not be read at all — usually the Server
      // Members intent. Distinct from an empty list, which means the bot is in
      // no server yet, and the two have different remedies.
      available: directory !== null,
      members: directory?.members ?? [],
      guilds: directory?.guilds ?? [],
      allowedUserIds: access.allowedUsers,
      allowlistExtras: access.allowlistExtras,
    });
  } catch (err) {
    console.error("[discord/members] failed:", err);
    return NextResponse.json({ error: "Member lookup failed" }, { status: 500 });
  }
}
