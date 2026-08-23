import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DiscordUnavailableError,
  fetchDiscordIntents,
  intentsFromApplicationFlags,
} from "@/lib/discord-api";

/**
 * The privileged-intents preflight.
 *
 * The failure it exists to catch: a valid token, a healthy-looking panel, and a
 * gateway that raises PrivilegedIntentsRequired the moment it tries to connect,
 * because MESSAGE CONTENT was never ticked in the Developer Portal.
 *
 * The trap inside the fix: Discord publishes each privileged intent twice — a
 * plain bit for a verified app and a `_LIMITED` bit for an unverified one. Every
 * ClawBox owner's bot is unverified, so reading only the plain bit would report
 * "intents missing" for a bot that is connected and answering.
 */

// Bit positions, spelled out rather than reused from the module, so a typo in
// the module's constants cannot make these tests agree with it.
const PRESENCE_LIMITED = 1 << 13;
const GUILD_MEMBERS = 1 << 14;
const GUILD_MEMBERS_LIMITED = 1 << 15;
const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const COMMAND_BADGE = 1 << 23;

describe("intentsFromApplicationFlags", () => {
  it("reports both intents off for an application that enabled neither", () => {
    expect(intentsFromApplicationFlags(0)).toEqual({
      messageContent: false,
      serverMembers: false,
    });
  });

  it("reports an unrelated flag as neither intent", () => {
    // A bot with the slash-command badge and nothing else must not read as
    // configured.
    expect(intentsFromApplicationFlags(COMMAND_BADGE)).toEqual({
      messageContent: false,
      serverMembers: false,
    });
  });

  it("accepts the verified (non-limited) bits", () => {
    expect(intentsFromApplicationFlags(MESSAGE_CONTENT | GUILD_MEMBERS)).toEqual({
      messageContent: true,
      serverMembers: true,
    });
  });

  it("accepts the LIMITED bits an unverified bot actually gets", () => {
    expect(intentsFromApplicationFlags(MESSAGE_CONTENT_LIMITED | GUILD_MEMBERS_LIMITED)).toEqual({
      messageContent: true,
      serverMembers: true,
    });
  });

  it("matches the flags read off the live bench bot while it was connected", () => {
    // 8953856 = presence-limited | members-limited | message-content-limited |
    // command badge. This bot was connected and answering messages at the time,
    // so anything that reports it as missing an intent is wrong by observation.
    const LIVE_FLAGS = 8953856;
    expect(LIVE_FLAGS).toBe(
      PRESENCE_LIMITED | GUILD_MEMBERS_LIMITED | MESSAGE_CONTENT_LIMITED | COMMAND_BADGE,
    );
    expect(intentsFromApplicationFlags(LIVE_FLAGS)).toEqual({
      messageContent: true,
      serverMembers: true,
    });
  });

  it("separates the two intents rather than treating them as one switch", () => {
    // Message Content on, Server Members off: the bot can read messages but the
    // member picker has nothing to list. Both halves have to be visible.
    expect(intentsFromApplicationFlags(MESSAGE_CONTENT_LIMITED)).toEqual({
      messageContent: true,
      serverMembers: false,
    });
    expect(intentsFromApplicationFlags(GUILD_MEMBERS_LIMITED)).toEqual({
      messageContent: false,
      serverMembers: true,
    });
  });
});

describe("fetchDiscordIntents", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function appResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the documented endpoint and never puts the token in the URL", async () => {
    fetchMock.mockResolvedValue(appResponse({ flags: MESSAGE_CONTENT_LIMITED }));
    await fetchDiscordIntents("a-token");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/applications/@me");
    expect(String(url)).not.toContain("a-token");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bot a-token");
  });

  it("treats an unreadable answer as unknown, not as 'intents are off'", async () => {
    // No `flags` key at all. Reporting this as "missing" would block a save on
    // a response shape change, which is the same dishonesty in reverse.
    fetchMock.mockResolvedValue(appResponse({ id: "1" }));
    await expect(fetchDiscordIntents("a-token")).rejects.toBeInstanceOf(DiscordUnavailableError);
  });

  it("treats a network failure as unknown rather than as a verdict", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchDiscordIntents("a-token")).rejects.toBeInstanceOf(DiscordUnavailableError);
  });
});
