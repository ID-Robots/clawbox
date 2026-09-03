import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * /setup-api/discord/status on the OPENCLAW edition — the connection state.
 *
 * This branch used to answer `state: null` with the comment "OpenClaw … exposes
 * no per-platform state file". That was true when it was written and is not
 * true of openclaw 2026.7.x: `openclaw channels status --json` publishes a
 * per-account row carrying `running`, `connected`, `tokenStatus` and
 * `lastError`. The panel's status card was therefore blank on a box whose bot
 * was answering in Discord.
 *
 * The rule that survives from the Hermes branch: `receiving` may be true ONLY
 * when the channel is genuinely connected — a bot once reported itself live and
 * dropped every message it received.
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-channels", () => ({ readCachedChannelStatus: vi.fn() }));
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
import { readCachedChannelStatus } from "@/lib/openclaw-channels";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockChannel = vi.mocked(readCachedChannelStatus);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

function botResponse() {
  return new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function row(over: Partial<NonNullable<Awaited<ReturnType<typeof readCachedChannelStatus>>>> = {}) {
  return {
    configured: true,
    running: true,
    connected: true,
    tokenStatus: "available" as const,
    restartPending: false,
    lastError: null,
    ...over,
  };
}

describe("GET /setup-api/discord/status — OpenClaw connection state", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    // The route holds module-level caches; a cache carried between tests would
    // answer the next one.
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => botResponse()));
    mockHarness.mockResolvedValue("openclaw");
    mockGet.mockResolvedValue(TOKEN);
    mockChannel.mockResolvedValue(row());
    GET = (await import("@/app/setup-api/discord/status/route")).GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a real state instead of null", async () => {
    const body = await (await GET()).json();

    expect(mockChannel).toHaveBeenCalledWith("discord");
    expect(body.state).toBe("connected");
    expect(body.receiving).toBe(true);
  });

  it("does not map a stopped channel with a recorded error to connected", async () => {
    mockChannel.mockResolvedValue(
      row({ running: false, connected: false, lastError: "connection closed" }),
    );

    const body = await (await GET()).json();

    expect(body.state).toBe("offline");
    expect(body.receiving).toBe(false);
  });

  it("never claims connected while the process is up but the socket is not", async () => {
    mockChannel.mockResolvedValue(row({ running: true, connected: false }));

    const body = await (await GET()).json();

    expect(body.state).toBe("offline");
    expect(body.receiving).toBe(false);
  });

  it("maps an unresolvable token to offline, not to connected", async () => {
    mockChannel.mockResolvedValue(
      row({ running: false, connected: false, tokenStatus: "configured_unavailable" }),
    );

    const body = await (await GET()).json();

    expect(body.state).toBe("offline");
    expect(body.receiving).toBe(false);
  });

  it("surfaces a privileged-intent failure as the state with a remedy", async () => {
    mockChannel.mockResolvedValue(
      row({
        running: true,
        connected: false,
        lastError: "Used disallowed intents (DisallowedIntents)",
      }),
    );

    expect((await (await GET()).json()).state).toBe("intents-missing");
  });

  it("reports unknown — not connected, and not an exception — when the CLI times out", async () => {
    mockChannel.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.state).toBeNull();
    expect(body.receiving).toBe(false);
    expect(body.configured).toBe(true);
  });

  it("names no bot at all when Discord is unreachable, rather than inventing one", async () => {
    // The gateway is NOT a second opinion on the bot's display name. Its
    // account row carries `bot`/`application` only when `channels status` is
    // run with `--probe`, and that probe is the gateway calling Discord — so it
    // answers only in the case where this route could have asked Discord
    // itself. Verified on a live connected bot (192.168.50.71): without
    // `--probe` the account row's keys are accountId, configured, connected,
    // enabled, lastError, running, tokenStatus … and no `bot`.
    //
    // So the offline answer is "no name", and the card must render around that
    // instead of showing a name nothing confirmed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND discord.com");
      }),
    );

    const body = await (await GET()).json();

    expect(body.username).toBeUndefined();
    // The channel state still comes through — losing the name loses nothing else.
    expect(body.state).toBe("connected");
  });

  it("still reports a rejected token when the channel probe says nothing", async () => {
    mockChannel.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );

    const body = await (await GET()).json();

    expect(body.tokenRejected).toBe(true);
    expect(body.state).toBeNull();
  });
});
