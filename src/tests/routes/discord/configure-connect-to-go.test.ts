import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * /setup-api/discord/configure — "connect and go" on OpenClaw.
 *
 * A saved token used to leave the owner one more step: tell the agent in the
 * chat the bot's Application ID, their server and their user id, because
 * nothing on the box wrote `applicationId`, `guilds` or `allowFrom`. The route
 * now reads all three from Discord with the token and writes them itself — and
 * `{sync:true}` finishes a bot that was invited to its server afterwards.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>("@/lib/openclaw-config");
  return {
    EnvSecretProviderConflictError: actual.EnvSecretProviderConflictError,
    GatewayNotReadyError: actual.GatewayNotReadyError,
    setDiscordToken: vi.fn(),
    setDiscordAccess: vi.fn(),
    restartGateway: vi.fn(),
  };
});
vi.mock("@/lib/openclaw-channels", () => ({
  ensureChannelPlugin: vi.fn(),
  invalidateChannelStatus: vi.fn(),
  waitForChannelConnected: vi.fn(),
}));
vi.mock("@/lib/hermes-discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-discord")>("@/lib/hermes-discord");
  return {
    DiscordEmptyAllowlistError: actual.DiscordEmptyAllowlistError,
    normalizeDiscordUserId: actual.normalizeDiscordUserId,
    setHermesDiscordToken: vi.fn(),
    setHermesDiscordAllowlist: vi.fn(),
    ensureHermesGateway: vi.fn(),
    readHermesDiscordAccess: vi.fn(),
  };
});

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { restartGateway, setDiscordAccess, setDiscordToken } from "@/lib/openclaw-config";
import { ensureChannelPlugin, waitForChannelConnected } from "@/lib/openclaw-channels";

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";
const APP_ID = "111111111111111111";
const GUILD_ID = "900000000000000001";
const OWNER_ID = "123456789012345678";
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const GUILD_MEMBERS_LIMITED = 1 << 15;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake Discord that answers per path; `guilds` is what the bot is in. */
function stubDiscord(guilds: Array<{ id: string; name: string; owner_id: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/users/@me")) return json({ id: APP_ID, username: "clawbot", discriminator: "0" });
      if (url.endsWith("/applications/@me")) {
        return json({ id: APP_ID, flags: MESSAGE_CONTENT_LIMITED | GUILD_MEMBERS_LIMITED });
      }
      if (url.includes("/users/@me/guilds")) return json(guilds.map(({ id, name }) => ({ id, name })));
      const guild = guilds.find((g) => url.endsWith(`/guilds/${g.id}`));
      if (guild) return json(guild);
      if (url.includes("/members")) return json([]);
      return json({}, 404);
    }),
  );
}

function connected() {
  return {
    configured: true,
    running: true,
    connected: true,
    tokenStatus: "available" as const,
    restartPending: false,
    lastError: null,
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/setup-api/discord/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /setup-api/discord/configure — connect and go (OpenClaw)", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(getActiveHarness).mockResolvedValue("openclaw");
    vi.mocked(set).mockResolvedValue();
    vi.mocked(get).mockResolvedValue(TOKEN);
    vi.mocked(setDiscordToken).mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    vi.mocked(ensureChannelPlugin).mockResolvedValue({ ok: true, installed: true });
    vi.mocked(waitForChannelConnected).mockResolvedValue(connected());
    POST = (await import("@/app/setup-api/discord/configure/route")).POST;
  });

  it("writes the application id, the server and its owner with the token", async () => {
    stubDiscord([{ id: GUILD_ID, name: "Home", owner_id: OWNER_ID }]);

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(vi.mocked(setDiscordToken)).toHaveBeenCalledWith(TOKEN, {
      applicationId: APP_ID,
      guilds: [{ id: GUILD_ID, ownerId: OWNER_ID }],
    });
    expect(body.success).toBe(true);
    expect(body.needsInvite).toBe(false);
    expect(body.inviteUrl).toBe(
      `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot+applications.commands&permissions=274878286912`,
    );
  });

  it("asks for an invite when the bot is in no server yet", async () => {
    stubDiscord([]);

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(body.needsInvite).toBe(true);
    expect(body.inviteUrl).toContain(`client_id=${APP_ID}`);
  });

  describe("{sync:true}", () => {
    it("writes nothing and restarts nothing while the bot is in no server", async () => {
      stubDiscord([]);

      const body = await (await POST(req({ sync: true }))).json();

      expect(body).toMatchObject({ success: true, needsInvite: true, changed: false });
      expect(vi.mocked(setDiscordAccess)).not.toHaveBeenCalled();
      expect(vi.mocked(restartGateway)).not.toHaveBeenCalled();
    });

    it("gives the new server's owner access and restarts once the bot joined", async () => {
      stubDiscord([{ id: GUILD_ID, name: "Home", owner_id: OWNER_ID }]);
      vi.mocked(setDiscordAccess).mockResolvedValue(true);

      const body = await (await POST(req({ sync: true }))).json();

      expect(vi.mocked(setDiscordAccess)).toHaveBeenCalledWith({
        applicationId: APP_ID,
        guilds: [{ id: GUILD_ID, ownerId: OWNER_ID }],
      });
      expect(vi.mocked(restartGateway)).toHaveBeenCalledTimes(1);
      expect(body).toMatchObject({ success: true, needsInvite: false, changed: true, connected: true });
    });

    it("does not restart when the server was already set up", async () => {
      stubDiscord([{ id: GUILD_ID, name: "Home", owner_id: OWNER_ID }]);
      vi.mocked(setDiscordAccess).mockResolvedValue(false);

      const body = await (await POST(req({ sync: true }))).json();

      expect(vi.mocked(restartGateway)).not.toHaveBeenCalled();
      expect(body).toMatchObject({ needsInvite: false, changed: false });
    });

    it("refuses without a saved token", async () => {
      vi.mocked(get).mockResolvedValue(undefined);
      stubDiscord([]);

      const res = await POST(req({ sync: true }));

      expect(res.status).toBe(400);
    });
  });
});
