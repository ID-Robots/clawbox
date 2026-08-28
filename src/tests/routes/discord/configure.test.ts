import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * /setup-api/discord/configure — validation, the live token check, and the
 * OpenClaw leg.
 *
 * The rule this file exists to hold: a token is only ever persisted after
 * Discord itself has accepted it. Discord tokens are opaque, so a save that
 * skipped the live check would report success for a token that can never log
 * in, and the only symptom would be a permanently silent bot.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  setDiscordToken: vi.fn(),
  restartGateway: vi.fn(),
}));
// On OpenClaw the channel is a separately-installed plugin, and the save is not
// finished until the gateway reports the channel up. Both live here; the
// default in beforeEach is the happy path so the assertions below stay about
// what they were about.
vi.mock("@/lib/openclaw-channels", () => ({
  ensureChannelPlugin: vi.fn(),
  waitForChannelConnected: vi.fn(),
}));
vi.mock("@/lib/hermes-discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-discord")>("@/lib/hermes-discord");
  return {
    // The error class has to be the REAL one: the route branches on
    // `instanceof`, and a stub would make every allowlist refusal fall through
    // to the generic 500 instead of the warning it is supposed to become.
    DiscordEmptyAllowlistError: actual.DiscordEmptyAllowlistError,
    // Real too: the route validates member ids with it before it writes
    // anything, so a stub would remove the check under test.
    normalizeDiscordUserId: actual.normalizeDiscordUserId,
    setHermesDiscordToken: vi.fn(),
    setHermesDiscordAllowlist: vi.fn(),
    ensureHermesGateway: vi.fn(),
  };
});

import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { setDiscordToken, restartGateway } from "@/lib/openclaw-config";
import { ensureChannelPlugin, waitForChannelConnected } from "@/lib/openclaw-channels";
import { setHermesDiscordToken } from "@/lib/hermes-discord";

const mockSet = vi.mocked(set);
const mockHarness = vi.mocked(getActiveHarness);
const mockSetDiscordToken = vi.mocked(setDiscordToken);
const mockRestartGateway = vi.mocked(restartGateway);
const mockSetHermesToken = vi.mocked(setHermesDiscordToken);
const mockEnsureChannelPlugin = vi.mocked(ensureChannelPlugin);
const mockWaitForChannel = vi.mocked(waitForChannelConnected);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

function discordOk() {
  return new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /setup-api/discord/configure", () => {
  let POST: (req: Request) => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

  function req(body: unknown, raw?: string): Request {
    return new Request("http://localhost/setup-api/discord/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    fetchMock = vi.fn(async () => discordOk());
    vi.stubGlobal("fetch", fetchMock);

    mockSet.mockResolvedValue();
    mockHarness.mockResolvedValue("openclaw");
    mockSetDiscordToken.mockResolvedValue();
    mockRestartGateway.mockResolvedValue();
    mockSetHermesToken.mockResolvedValue();
    mockEnsureChannelPlugin.mockResolvedValue({ ok: true, installed: false });
    mockWaitForChannel.mockResolvedValue({
      configured: true,
      running: true,
      connected: true,
      tokenStatus: "available",
      restartPending: false,
      lastError: null,
      botUsername: "clawbot",
    });

    POST = (await import("@/app/setup-api/discord/configure/route")).POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("input validation", () => {
    it("rejects a malformed body", async () => {
      const res = await POST(req(null, "{not json"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a missing token", async () => {
      const res = await POST(req({}));
      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("rejects a token that could be read as a CLI flag", async () => {
      const res = await POST(req({ botToken: `-${TOKEN}` }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid bot token format");
      // Nothing is asked of Discord and nothing is stored.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("rejects a token carrying a newline (a systemd env-file injection)", async () => {
      const res = await POST(req({ botToken: `${TOKEN}\nDISCORD_ALLOW_ALL_USERS=true` }));
      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("trims surrounding whitespace from a pasted token", async () => {
      const res = await POST(req({ botToken: `  ${TOKEN}\t` }));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
    });
  });

  describe("live token check", () => {
    it("asks Discord before storing anything", async () => {
      await POST(req({ botToken: TOKEN }));

      // The identity check is FIRST — the intents preflight and the member
      // lookup that follow it only run once Discord has accepted the token.
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("/users/@me");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
      // And nothing had been written by the time it was asked.
      expect(mockSet.mock.invocationCallOrder[0]).toBeGreaterThan(
        fetchMock.mock.invocationCallOrder[0],
      );
    });

    it("refuses a token Discord rejects, and stores nothing", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "401: Unauthorized" }), { status: 401 }));

      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/rejected this bot token/i);
      expect(mockSet).not.toHaveBeenCalled();
      expect(mockSetDiscordToken).not.toHaveBeenCalled();
      expect(mockRestartGateway).not.toHaveBeenCalled();
    });

    it("says 'could not reach Discord' rather than blaming the token when offline", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/couldn't reach discord/i);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("does not treat a rate limit as a bad token", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
      const res = await POST(req({ botToken: TOKEN }));
      expect(res.status).toBe(502);
    });

    it("returns the bot name so the UI can show it immediately", async () => {
      const res = await POST(req({ botToken: TOKEN }));
      expect(await res.json()).toMatchObject({ success: true, username: "clawbot" });
    });
  });

  describe("on an OpenClaw device", () => {
    it("writes the channel config and restarts the gateway", async () => {
      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
      expect(mockSetDiscordToken).toHaveBeenCalledWith(TOKEN);
      expect(mockRestartGateway).toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ success: true, restarted: true });
      expect(mockSetHermesToken).not.toHaveBeenCalled();
    });

    it("stores before wiring, so a harness failure cannot lose the token", async () => {
      const order: string[] = [];
      mockSet.mockImplementation(async () => {
        order.push("store");
      });
      mockSetDiscordToken.mockImplementation(async () => {
        order.push("harness");
      });

      await POST(req({ botToken: TOKEN }));

      expect(order).toEqual(["store", "harness"]);
    });

    it("reports a restart failure as restart_pending, and not as a success", async () => {
      mockRestartGateway.mockRejectedValue(new Error("systemctl: unit is masked"));

      const res = await POST(req({ botToken: TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
      // A machine token, not a sentence: the panel maps it to a translated
      // string. The English phrase this used to return was the one piece of
      // Discord copy that never went through i18n.
      //
      // `success` is false because the channel is not receiving anything: the
      // config is on disk and the gateway is still running the old one. It used
      // to answer `success: true` here, which is how a box with a bot that had
      // never connected reported a clean save.
      expect(body).toMatchObject({
        success: false,
        restarted: false,
        warning: "restart_pending",
        code: "restart_pending",
      });
    });
  });

  describe("secret handling", () => {
    it("never returns the token in any response", async () => {
      const responses = [
        await POST(req({ botToken: TOKEN })),
        await (async () => {
          mockRestartGateway.mockRejectedValueOnce(new Error("boom"));
          return POST(req({ botToken: TOKEN }));
        })(),
        await (async () => {
          mockSetDiscordToken.mockRejectedValueOnce(new Error(`config set discord ${TOKEN} failed`));
          return POST(req({ botToken: TOKEN }));
        })(),
      ];

      for (const res of responses) {
        expect(await res.text()).not.toContain(TOKEN);
      }
    });

    it("never logs the token when the harness call fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockSetDiscordToken.mockRejectedValue(new Error(`openclaw config set channels.discord ${TOKEN}`));

      const res = await POST(req({ botToken: TOKEN }));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Failed to save");
      for (const call of errorSpy.mock.calls) {
        expect(JSON.stringify(call.map(String))).not.toContain(TOKEN);
      }
      errorSpy.mockRestore();
    });
  });
});
