import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-discord")>("@/lib/hermes-discord");
  return {
    mapDiscordConnectionState: actual.mapDiscordConnectionState,
    DISCORD_AUTH_ERROR_CODE: actual.DISCORD_AUTH_ERROR_CODE,
    hermesDiscordRegistered: vi.fn(),
    hermesGatewayStatus: vi.fn(),
    readHermesGatewaySnapshot: vi.fn(async () => ({ gatewayState: null, platform: null })),
    readHermesDiscordAccess: vi.fn(async () => ({
      allowedUsers: [],
      allowlistExtras: [],
      allowedRoles: [],
      allowedChannels: [],
      allowAllUsers: false,
      authorized: false,
    })),
  };
});

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

function botResponse() {
  return new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /setup-api/discord/status — OpenClaw", () => {
  let GET: () => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // resetModules matters here: the route holds module-level caches, and a
    // cache carried between tests would answer the next one.
    vi.resetModules();
    vi.clearAllMocks();

    fetchMock = vi.fn(async () => botResponse());
    vi.stubGlobal("fetch", fetchMock);

    mockHarness.mockResolvedValue("openclaw");
    mockGet.mockResolvedValue(TOKEN);

    GET = (await import("@/app/setup-api/discord/status/route")).GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports not-configured when no token is stored", async () => {
    mockGet.mockResolvedValue(undefined);

    const res = await GET();

    expect(await res.json()).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the bot username when configured", async () => {
    const res = await GET();
    expect(await res.json()).toMatchObject({
      configured: true,
      username: "clawbot",
      botId: "42",
      tokenRejected: false,
    });
  });

  it("keeps a legacy discriminator in the reported name", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0451" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await (await GET()).json()).toMatchObject({ username: "clawbot#0451" });
  });

  it("flags a token Discord no longer accepts", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    const body = await (await GET()).json();

    // Still "configured" — a token IS stored — but the UI needs to know why the
    // bot is silent.
    expect(body).toMatchObject({ configured: true, tokenRejected: true });
    expect(body.username).toBeUndefined();
  });

  it("does not flag the token when Discord is merely unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const body = await (await GET()).json();

    expect(body).toMatchObject({ configured: true, tokenRejected: false });
  });

  it("never returns the token itself", async () => {
    expect(await (await GET()).text()).not.toContain(TOKEN);
  });

  it("coalesces concurrent callers onto one Discord request", async () => {
    // The Settings panel and the section subtitle both read this route.
    await Promise.all([GET(), GET(), GET()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat call from cache", async () => {
    await GET();
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
