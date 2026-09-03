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
  // A REAL class: the route narrows on `instanceof GatewayNotReadyError` to tell
  // "the gateway has not finished binding" from "the restart was refused", and
  // `instanceof undefined` throws a TypeError the first time a test makes the
  // mocked restart reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
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

  function req(signal?: AbortSignal): Request {
    return new Request("http://localhost/setup-api/discord/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: TOKEN }),
      ...(signal ? { signal } : {}),
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
    mockEnsureGateway.mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });

    POST = (await import("@/app/setup-api/discord/configure/route")).POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the token to Hermes and brings its messaging gateway up", async () => {
    const res = await POST(req());

    expect(res.status).toBe(200);
    // One argument, deliberately: no abort signal — see the split-brain test
    // further down this describe.
    expect(mockSetHermesToken).toHaveBeenCalledWith(TOKEN);
    expect(mockEnsureGateway).toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ success: true, restarted: true, username: "clawbot" });
  });

  it("never touches the OpenClaw gateway on a Hermes device", async () => {
    await POST(req());
    expect(mockSetDiscordToken).not.toHaveBeenCalled();
    expect(mockRestartGateway).not.toHaveBeenCalled();
  });

  it("reports a gateway that would not come up as saved-with-warning", async () => {
    mockEnsureGateway.mockResolvedValue({ installed: true, running: false, scope: "system", applied: false });

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

  it("does not let a browser that walked away cancel the half it has already committed to", async () => {
    // Three Discord round trips happen before anything is written, the last of
    // them a guild-member listing that takes seconds on a large server. A phone
    // that locks in that window aborts the fetch AFTER
    // `set("discord_bot_token")` has committed to ClawBox's own store. Handing
    // `request.signal` any further down makes that a RELIABLE split-brain:
    // `runHermesCli` refuses a call whose signal is already aborted, so the
    // token sits in ClawBox's store, never reaches ~/.hermes/.env, no allowlist
    // is written and the gateway is never restarted — and the 500 that explains
    // it goes to a browser nobody is looking at.
    const controller = new AbortController();
    mockSet.mockImplementation(async (key: string) => {
      if (key === "discord_bot_token") controller.abort();
    });
    // Model the real library: it goes through `runHermesCli`, which refuses.
    mockSetHermesToken.mockImplementation(async (_token: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("hermes call cancelled");
    });

    const res = await POST(req(controller.signal));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, restarted: true });
    expect(mockSet).toHaveBeenCalledWith("discord_bot_token", TOKEN);
    // One argument, deliberately: past the first durable write, finish the job.
    expect(mockSetHermesToken).toHaveBeenCalledWith(TOKEN);
    // And the two steps that follow it are not skipped.
    expect(mockSetAllowlist).toHaveBeenCalled();
    expect(mockEnsureGateway).toHaveBeenCalled();
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
