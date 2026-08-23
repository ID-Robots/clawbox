import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * /setup-api/discord/configure — the two things that used to make a *valid*
 * token useless, both observed live on the bench box:
 *
 *   1. MESSAGE CONTENT was never enabled in the Developer Portal, so the
 *      gateway raised PrivilegedIntentsRequired while the panel reported
 *      "receiving: true".
 *   2. No allowlist existed, so the adapter denied every message it received
 *      and said so only in the gateway log.
 *
 * Both are now decided inside this route, against Discord's own API.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  setDiscordToken: vi.fn(),
  restartGateway: vi.fn(),
}));
vi.mock("@/lib/hermes-discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-discord")>("@/lib/hermes-discord");
  return {
    // Real error class: the route branches on `instanceof`, so a stub would
    // turn every allowlist refusal into a generic 500.
    DiscordEmptyAllowlistError: actual.DiscordEmptyAllowlistError,
    setHermesDiscordToken: vi.fn(),
    setHermesDiscordAllowlist: vi.fn(),
    ensureHermesGateway: vi.fn(),
  };
});

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  DiscordEmptyAllowlistError,
  ensureHermesGateway,
  setHermesDiscordAllowlist,
  setHermesDiscordToken,
} from "@/lib/hermes-discord";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockHarness = vi.mocked(getActiveHarness);
const mockSetToken = vi.mocked(setHermesDiscordToken);
const mockSetAllowlist = vi.mocked(setHermesDiscordAllowlist);
const mockEnsureGateway = vi.mocked(ensureHermesGateway);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";
const GUILD_ID = "900000000000000001";
const OWNER_ID = "100000000000000001";
const FRIEND_ID = "100000000000000002";
const BOT_MEMBER_ID = "100000000000000003";

// The bits an UNVERIFIED bot gets — the only ones a ClawBox owner will ever
// have. See src/tests/unit/discord-intents.test.ts.
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const GUILD_MEMBERS_LIMITED = 1 << 15;
const BOTH_INTENTS = MESSAGE_CONTENT_LIMITED | GUILD_MEMBERS_LIMITED;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ApiOptions {
  flags?: number;
  /** HTTP status for GET /guilds/{id}/members. 403 = Server Members intent off. */
  membersStatus?: number;
  guilds?: { id: string; name: string }[];
}

/** A Discord that answers each documented endpoint the route actually calls. */
function discordApi(options: ApiOptions = {}) {
  const { flags = BOTH_INTENTS, membersStatus = 200, guilds = [{ id: GUILD_ID, name: "Bench" }] } =
    options;

  return vi.fn(async (input: unknown) => {
    const url = String(input);
    // Checked before /users/@me, which is a prefix of it.
    if (url.includes("/users/@me/guilds")) return json(guilds);
    if (url.includes("/users/@me")) {
      return json({ id: "42", username: "clawbot", discriminator: "0" });
    }
    if (url.includes("/applications/@me")) return json({ id: "42", flags });
    if (url.includes("/members")) {
      if (membersStatus !== 200) return json({ message: "Missing Access" }, membersStatus);
      return json([
        {
          nick: "Owner Nick",
          user: { id: OWNER_ID, username: "owner", global_name: "Owner Global" },
        },
        { nick: null, user: { id: FRIEND_ID, username: "friend", global_name: "Friend" } },
        { nick: null, user: { id: BOT_MEMBER_ID, username: "somebot", bot: true } },
      ]);
    }
    if (url.includes("/guilds/")) return json({ id: GUILD_ID, owner_id: OWNER_ID });
    return json({}, 404);
  });
}

describe("POST /setup-api/discord/configure — onboarding", () => {
  let POST: (req: Request) => Promise<Response>;

  function req(body: unknown): Request {
    return new Request("http://localhost/setup-api/discord/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function useApi(options?: ApiOptions) {
    const fetchMock = discordApi(options);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSet.mockResolvedValue();
    mockGet.mockResolvedValue(TOKEN);
    mockHarness.mockResolvedValue("hermes");
    mockSetToken.mockResolvedValue();
    mockEnsureGateway.mockResolvedValue({ installed: true, running: true, scope: "system" });
    mockSetAllowlist.mockImplementation(async (ids: string[]) => ({
      changedKeys: ids.length > 0 ? ["DISCORD_ALLOWED_USERS"] : [],
      allowedUsers: ids,
      authorized: ids.length > 0,
    }));

    POST = (await import("@/app/setup-api/discord/configure/route")).POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("intents preflight", () => {
    it("refuses the save when Message Content was never enabled", async () => {
      useApi({ flags: GUILD_MEMBERS_LIMITED });

      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe("intents_missing");
      expect(body.missingIntents).toContain("MESSAGE CONTENT INTENT");
      expect(body.portalUrl).toContain("discord.com/developers/applications");
      // Nothing at all is written: a stored token plus a gateway that cannot
      // connect is exactly the state this refusal exists to prevent.
      expect(mockSet).not.toHaveBeenCalled();
      expect(mockSetToken).not.toHaveBeenCalled();
      expect(mockSetAllowlist).not.toHaveBeenCalled();
      expect(mockEnsureGateway).not.toHaveBeenCalled();
    });

    it("names the Server Members intent too when both are off", async () => {
      useApi({ flags: 0 });
      const body = await (await POST(req({ botToken: TOKEN }))).json();
      expect(body.missingIntents).toEqual([
        "MESSAGE CONTENT INTENT",
        "SERVER MEMBERS INTENT",
      ]);
    });

    it("passes on the LIMITED bits an unverified bot actually gets", async () => {
      useApi({ flags: BOTH_INTENTS });

      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.intents).toEqual({ messageContent: true, serverMembers: true });
      expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
    });

    it("does not block the save when the intents could not be read at all", async () => {
      // Unknown is not "off". Blocking on a network blip would be the same
      // dishonesty pointing the other way.
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/applications/@me")) throw new TypeError("fetch failed");
        if (url.includes("/users/@me/guilds")) return json([]);
        if (url.includes("/users/@me")) return json({ id: "42", username: "clawbot" });
        return json({}, 404);
      });
      vi.stubGlobal("fetch", fetchMock);

      const res = await POST(req({ botToken: TOKEN }));
      expect(res.status).toBe(200);
      expect((await res.json()).intents).toBeNull();
      expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
    });
  });

  describe("member lookup and the default selection", () => {
    it("lists humans and leaves bots out of the picker", async () => {
      useApi();
      const body = await (await POST(req({ botToken: TOKEN }))).json();

      const ids = body.members.map((m: { id: string }) => m.id);
      expect(ids).toEqual([OWNER_ID, FRIEND_ID]);
      expect(ids).not.toContain(BOT_MEMBER_ID);
    });

    it("prefers a server nickname over the global name for the label", async () => {
      useApi();
      const body = await (await POST(req({ botToken: TOKEN }))).json();
      expect(body.members[0].displayName).toBe("Owner Nick");
      expect(body.members[1].displayName).toBe("Friend");
    });

    it("pre-selects the guild owner, which is the id that fixed this by hand", async () => {
      useApi();
      const body = await (await POST(req({ botToken: TOKEN }))).json();

      expect(mockSetAllowlist).toHaveBeenCalledWith([OWNER_ID]);
      expect(body.allowedUserIds).toEqual([OWNER_ID]);
      expect(body.members.find((m: { id: string }) => m.id === OWNER_ID).isOwner).toBe(true);
    });

    it("uses the panel's selection when one is sent instead of the default", async () => {
      useApi();
      await POST(req({ botToken: TOKEN, allowedUserIds: [OWNER_ID, FRIEND_ID] }));
      expect(mockSetAllowlist).toHaveBeenCalledWith([OWNER_ID, FRIEND_ID]);
    });

    it("still knows the owner when Discord refuses the member list", async () => {
      // 403 is what a bot without the Server Members intent gets. owner_id comes
      // from GET /guilds/{id}, which needs no privileged intent, so the default
      // selection survives.
      useApi({ membersStatus: 403 });
      const body = await (await POST(req({ botToken: TOKEN }))).json();

      expect(body.members).toHaveLength(1);
      expect(body.members[0].id).toBe(OWNER_ID);
      expect(body.guilds[0].membersReadable).toBe(false);
      expect(mockSetAllowlist).toHaveBeenCalledWith([OWNER_ID]);
    });

    it("warns rather than failing when the bot is in no server yet", async () => {
      useApi({ guilds: [] });
      mockSetAllowlist.mockRejectedValue(new DiscordEmptyAllowlistError());

      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      // The token is good and is kept; the missing half is named.
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.warning).toBe("no_allowed_users");
      expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
    });

    it("never puts the token in a URL", async () => {
      const fetchMock = useApi();
      await POST(req({ botToken: TOKEN }));
      for (const [url] of fetchMock.mock.calls) {
        expect(String(url)).not.toContain(TOKEN);
      }
    });

    it("never returns the token in the response body", async () => {
      useApi();
      const res = await POST(req({ botToken: TOKEN }));
      expect(await res.text()).not.toContain(TOKEN);
    });
  });

  describe("allowlist-only save", () => {
    it("writes the selection and restarts the gateway", async () => {
      useApi();
      const res = await POST(req({ allowedUserIds: [OWNER_ID, FRIEND_ID] }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.restarted).toBe(true);
      expect(mockSetAllowlist).toHaveBeenCalledWith([OWNER_ID, FRIEND_ID]);
      expect(mockEnsureGateway).toHaveBeenCalled();
      // The token is untouched — this save is only about access.
      expect(mockSetToken).not.toHaveBeenCalled();
    });

    it("refuses an empty selection rather than saving a bot nobody can reach", async () => {
      useApi();
      mockSetAllowlist.mockRejectedValue(new DiscordEmptyAllowlistError());

      const res = await POST(req({ allowedUserIds: [] }));

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("empty_allowlist");
      expect(mockEnsureGateway).not.toHaveBeenCalled();
    });

    it("does not restart the gateway for a save that changed nothing", async () => {
      // The bench box already had DISCORD_ALLOWED_USERS set by hand; ticking the
      // same person must not bounce the gateway.
      useApi();
      mockSetAllowlist.mockResolvedValue({
        changedKeys: [],
        allowedUsers: [OWNER_ID],
        authorized: true,
      });

      const body = await (await POST(req({ allowedUserIds: [OWNER_ID] }))).json();

      expect(body.unchanged).toBe(true);
      expect(body.restarted).toBe(false);
      expect(mockEnsureGateway).not.toHaveBeenCalled();
    });

    it("reports a pending restart honestly instead of claiming success", async () => {
      useApi();
      mockEnsureGateway.mockResolvedValue({ installed: true, running: false, scope: "system" });

      const body = await (await POST(req({ allowedUserIds: [OWNER_ID] }))).json();

      expect(body.success).toBe(true);
      expect(body.restarted).toBe(false);
      expect(body.warning).toBe("restart_pending");
    });

    it("needs a stored token before it will write an allowlist", async () => {
      useApi();
      mockGet.mockResolvedValue(null);

      const res = await POST(req({ allowedUserIds: [OWNER_ID] }));
      expect(res.status).toBe(400);
      expect(mockSetAllowlist).not.toHaveBeenCalled();
    });

    it("rejects a non-array selection", async () => {
      useApi();
      const res = await POST(req({ allowedUserIds: "nope" }));
      expect(res.status).toBe(400);
      expect(mockSetAllowlist).not.toHaveBeenCalled();
    });

    it("caps how many people one save can carry", async () => {
      useApi();
      const many = Array.from({ length: 65 }, (_, i) => `10000000000000${String(i).padStart(4, "0")}`);
      const res = await POST(req({ allowedUserIds: many }));
      expect(res.status).toBe(400);
      expect(mockSetAllowlist).not.toHaveBeenCalled();
    });

    it("has nothing to do without a token or a selection", async () => {
      useApi();
      const res = await POST(req({}));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Nothing to update");
    });

    it("does not pretend OpenClaw has an env allowlist", async () => {
      useApi();
      mockHarness.mockResolvedValue("openclaw");

      const res = await POST(req({ allowedUserIds: [OWNER_ID] }));
      expect(res.status).toBe(501);
      expect(mockSetAllowlist).not.toHaveBeenCalled();
    });
  });
});
