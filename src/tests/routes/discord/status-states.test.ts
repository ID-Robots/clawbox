import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The four states /setup-api/discord/status reports, and the rule that binds
 * them: `receiving` may be true ONLY when Discord is genuinely connected.
 *
 * What it used to report was `configured && gateway.running`. Both were true on
 * the bench box while the Discord adapter was failing to connect at all, and
 * again later while it was dropping every message it received for want of an
 * allowlist. The panel said "receiving: true" through both.
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-discord")>("@/lib/hermes-discord");
  return {
    // Pure mapping — the thing under test. Only the readers are stubbed.
    mapDiscordConnectionState: actual.mapDiscordConnectionState,
    DISCORD_AUTH_ERROR_CODE: actual.DISCORD_AUTH_ERROR_CODE,
    hermesDiscordRegistered: vi.fn(),
    hermesGatewayStatus: vi.fn(),
    readHermesGatewaySnapshot: vi.fn(),
    readHermesDiscordAccess: vi.fn(),
  };
});

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  hermesDiscordRegistered,
  hermesGatewayStatus,
  readHermesDiscordAccess,
  readHermesGatewaySnapshot,
} from "@/lib/hermes-discord";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockRegistered = vi.mocked(hermesDiscordRegistered);
const mockGateway = vi.mocked(hermesGatewayStatus);
const mockSnapshot = vi.mocked(readHermesGatewaySnapshot);
const mockAccess = vi.mocked(readHermesDiscordAccess);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";
const OWNER = "100000000000000001";

function access(overrides: Partial<Awaited<ReturnType<typeof readHermesDiscordAccess>>> = {}) {
  return {
    allowedUsers: [OWNER],
    allowlistExtras: [],
    allowedRoles: [],
    allowedChannels: [],
    allowAllUsers: false,
    authorized: true,
    ...overrides,
  };
}

function snapshot(state: string | null, errorCode: string | null = null) {
  return {
    gatewayState: "running",
    platform: state === null ? null : { state, errorCode, updatedAt: null },
  };
}

describe("GET /setup-api/discord/status — connection states", () => {
  let GET: () => Promise<Response>;

  async function load() {
    // The route caches per token for 15 s, so each case gets a fresh module.
    vi.resetModules();
    GET = (await import("@/app/setup-api/discord/status/route")).GET;
    return (await GET()).json();
  }

  beforeEach(() => {
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

    mockGet.mockResolvedValue(TOKEN);
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(true);
    mockGateway.mockResolvedValue({ installed: true, running: true, scope: "system" });
    mockSnapshot.mockResolvedValue(snapshot("connected"));
    mockAccess.mockResolvedValue(access());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports connected, and only then may say it is receiving", async () => {
    const body = await load();
    expect(body.state).toBe("connected");
    expect(body.receiving).toBe(true);
    expect(body.authorized).toBe(true);
    expect(body.allowedUserIds).toEqual([OWNER]);
  });

  it("reports intents-missing, not receiving, from the adapter's error code", async () => {
    // Friction 1: the panel said "receiving: true" while the gateway logged
    // discord.errors.PrivilegedIntentsRequired.
    mockSnapshot.mockResolvedValue(snapshot("error", "discord_intents_required"));

    const body = await load();

    expect(body.state).toBe("intents-missing");
    expect(body.receiving).toBe(false);
    expect(body.platformErrorCode).toBe("discord_intents_required");
  });

  it("reports denied-no-allowlist for a connected bot nobody may talk to", async () => {
    // Friction 2: connected, healthy, and dropping every message.
    mockAccess.mockResolvedValue(access({ allowedUsers: [], authorized: false }));

    const body = await load();

    expect(body.state).toBe("denied-no-allowlist");
    expect(body.receiving).toBe(false);
    expect(body.allowedUserIds).toEqual([]);
  });

  it("counts a role rule as an allowlist, because the adapter does", async () => {
    mockAccess.mockResolvedValue(access({ allowedUsers: [], allowedRoles: ["9"], authorized: true }));
    const body = await load();
    expect(body.state).toBe("connected");
  });

  it("reports offline when the gateway process is down", async () => {
    mockGateway.mockResolvedValue({ installed: true, running: false, scope: "system" });
    const body = await load();
    expect(body.state).toBe("offline");
    expect(body.receiving).toBe(false);
  });

  it("reports offline when the gateway knows nothing about Discord yet", async () => {
    mockSnapshot.mockResolvedValue(snapshot(null));
    const body = await load();
    expect(body.state).toBe("offline");
  });

  it("reports offline when there is no snapshot to read at all", async () => {
    mockSnapshot.mockResolvedValue({ gatewayState: null, platform: null });
    const body = await load();
    expect(body.state).toBe("offline");
    expect(body.receiving).toBe(false);
  });

  it("surfaces a token Discord revoked while the gateway was running", async () => {
    mockSnapshot.mockResolvedValue(snapshot("error", "discord_auth_error"));
    const body = await load();
    expect(body.tokenRejected).toBe(true);
    expect(body.state).toBe("offline");
  });

  it("lets Hermes' 'no Discord platform' outrank a stale snapshot", async () => {
    mockRegistered.mockResolvedValue(false);
    const body = await load();
    expect(body.configured).toBe(false);
    expect(body.state).toBe("offline");
    expect(body.receiving).toBe(false);
  });

  it("shows an allow-everyone flag somebody set by hand", async () => {
    mockAccess.mockResolvedValue(access({ allowAllUsers: true }));
    const body = await load();
    expect(body.allowAllUsers).toBe(true);
  });

  it("keeps the raw platform word so an unforeseen state is still visible", async () => {
    mockSnapshot.mockResolvedValue(snapshot("retrying", "discord_connect_error"));
    const body = await load();
    expect(body.state).toBe("offline");
    expect(body.platformState).toBe("retrying");
    expect(body.platformErrorCode).toBe("discord_connect_error");
  });

  it("never returns the token", async () => {
    vi.resetModules();
    const route = await import("@/app/setup-api/discord/status/route");
    expect(await (await route.GET()).text()).not.toContain(TOKEN);
  });
});
