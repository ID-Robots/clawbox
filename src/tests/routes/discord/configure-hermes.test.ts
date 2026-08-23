import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The Hermes leg of /setup-api/discord/configure.
 *
 * A Hermes ClawBox has no OpenClaw gateway at all (the unit is masked, the port
 * is closed), so driving the OpenClaw path there would store a token nothing
 * reads — the exact bug the Telegram integration was fixed for. Discord must
 * fork on the active harness from the start.
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
    // The error class has to be the REAL one: the route branches on
    // `instanceof`, and a stub would make every allowlist refusal fall through
    // to the generic 500 instead of the warning it is supposed to become.
    DiscordEmptyAllowlistError: actual.DiscordEmptyAllowlistError,
    setHermesDiscordToken: vi.fn(),
    setHermesDiscordAllowlist: vi.fn(),
    ensureHermesGateway: vi.fn(),
  };
});

import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { setDiscordToken, restartGateway } from "@/lib/openclaw-config";
import {
  setHermesDiscordToken,
  setHermesDiscordAllowlist,
  ensureHermesGateway,
} from "@/lib/hermes-discord";

const mockSet = vi.mocked(set);
const mockHarness = vi.mocked(getActiveHarness);
const mockSetDiscordToken = vi.mocked(setDiscordToken);
const mockRestartGateway = vi.mocked(restartGateway);
const mockSetHermesToken = vi.mocked(setHermesDiscordToken);
const mockEnsureGateway = vi.mocked(ensureHermesGateway);
const mockSetAllowlist = vi.mocked(setHermesDiscordAllowlist);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

describe("POST /setup-api/discord/configure — Hermes", () => {
  let POST: (req: Request) => Promise<Response>;

  function req(): Request {
    return new Request("http://localhost/setup-api/discord/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: TOKEN }),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    mockSet.mockResolvedValue();
    mockHarness.mockResolvedValue("hermes");
    mockSetHermesToken.mockResolvedValue();
    mockSetAllowlist.mockResolvedValue({ changedKeys: [], allowedUsers: [], authorized: true });
    mockEnsureGateway.mockResolvedValue({ installed: true, running: true, scope: "system" });

    POST = (await import("@/app/setup-api/discord/configure/route")).POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the token to Hermes and brings its messaging gateway up", async () => {
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(mockSetHermesToken).toHaveBeenCalledWith(TOKEN, expect.anything());
    expect(mockEnsureGateway).toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ success: true, restarted: true, username: "clawbot" });
  });

  it("never touches the OpenClaw gateway on a Hermes device", async () => {
    await POST(req());
    expect(mockSetDiscordToken).not.toHaveBeenCalled();
    expect(mockRestartGateway).not.toHaveBeenCalled();
  });

  it("reports a gateway that would not come up as saved-with-warning", async () => {
    mockEnsureGateway.mockResolvedValue({ installed: true, running: false, scope: "system" });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    // A machine token the panel translates, not an English sentence.
    expect(body).toMatchObject({ success: true, restarted: false, warning: "restart_pending" });
  });

  it("keeps the save when the gateway call throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockEnsureGateway.mockRejectedValue(new Error("sudo: a password is required"));

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, restarted: false });
    // The token was already persisted before the gateway was touched.
    expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
    errorSpy.mockRestore();
  });

  it("does not reach Hermes at all when Discord rejects the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));

    const res = await POST(req());

    expect(res.status).toBe(400);
    expect(mockSetHermesToken).not.toHaveBeenCalled();
    expect(mockEnsureGateway).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});
