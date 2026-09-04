import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * /setup-api/discord/configure on the OPENCLAW edition.
 *
 * Two defects, both proven live on a box running openclaw 2026.7.1-2:
 *
 *  1. OpenClaw's stock extensions carry no Discord channel at all. The gateway
 *     logged "channels.discord is configured but no channel plugin is installed
 *     or loadable (no-channel-owner)" while this route reported success.
 *  2. Even with the plugin present the channel died in a restart loop, because
 *     the env SecretRef we write resolves through `secrets.providers.default`
 *     and we never wrote one.
 *
 * The rule this file holds: THIS ROUTE MAY NOT ANSWER SUCCESS UNTIL THE CHANNEL
 * IS ACTUALLY REACHABLE. A save that ends with a silent bot has to say which of
 * the three things went wrong.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>(
    "@/lib/openclaw-config",
  );
  return {
    // The real error class: the route branches on `instanceof`, so a stub would
    // turn the one refusal that protects the gateway into a generic 500.
    EnvSecretProviderConflictError: actual.EnvSecretProviderConflictError,
    // Same reason, for the other class the route branches on: a slow-but-healthy
    // restart must not be reported as a failed save.
    GatewayNotReadyError: actual.GatewayNotReadyError,
    setDiscordToken: vi.fn(),
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
  };
});

import { getActiveHarness } from "@/lib/harness";
import {
  EnvSecretProviderConflictError,
  restartGateway,
  setDiscordToken,
} from "@/lib/openclaw-config";
import { ensureChannelPlugin, waitForChannelConnected } from "@/lib/openclaw-channels";
import { set } from "@/lib/config-store";

const mockHarness = vi.mocked(getActiveHarness);
const mockSetDiscordToken = vi.mocked(setDiscordToken);
const mockRestart = vi.mocked(restartGateway);
const mockEnsurePlugin = vi.mocked(ensureChannelPlugin);
const mockWait = vi.mocked(waitForChannelConnected);
const mockSet = vi.mocked(set);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";
/** A syntactically valid Discord snowflake — the route normalises ids before it writes. */
const OWNER_ID = "123456789012345678";

function discordOk() {
  return new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

describe("POST /setup-api/discord/configure (OpenClaw channel plugin)", () => {
  let POST: (req: Request) => Promise<Response>;

  function req(body: unknown): Request {
    return new Request("http://localhost/setup-api/discord/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => discordOk()));
    mockSet.mockResolvedValue();
    mockHarness.mockResolvedValue("openclaw");
    mockSetDiscordToken.mockResolvedValue();
    mockRestart.mockResolvedValue();
    mockEnsurePlugin.mockResolvedValue({ ok: true, installed: true });
    mockWait.mockResolvedValue(connected());
    POST = (await import("@/app/setup-api/discord/configure/route")).POST;
  });

  it("installs the Discord channel plugin before writing the channel config", async () => {
    const res = await POST(req({ botToken: TOKEN }));
    const body = await res.json();

    expect(mockEnsurePlugin).toHaveBeenCalledWith("discord");
    expect(body.success).toBe(true);
    // Order is load-bearing: `plugins install` writes plugins.entries.<id> into
    // openclaw.json, and setDiscordToken read-modify-writes the same file. The
    // other order silently drops the enable the installer just made.
    expect(mockEnsurePlugin.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetDiscordToken.mock.invocationCallOrder[0],
    );
  });

  it("does not report success when the channel never reaches connected", async () => {
    mockWait.mockResolvedValue({ ...connected(), running: false, connected: false });

    const res = await POST(req({ botToken: TOKEN }));
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.warning).toBe("not_connected");
    // The credential is still on disk — the owner must not have to paste it
    // again to retry.
    expect(mockSetDiscordToken).toHaveBeenCalledWith(TOKEN);
  });

  it("names an unresolvable token rather than calling it 'not connected'", async () => {
    mockWait.mockResolvedValue({
      ...connected(),
      running: false,
      connected: false,
      tokenStatus: "configured_unavailable",
    });

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(body.success).toBe(false);
    expect(body.warning).toBe("token_unresolved");
  });

  it("names a failed plugin install rather than calling it 'not connected'", async () => {
    mockEnsurePlugin.mockResolvedValue({ ok: false, reason: "install_failed" });
    mockWait.mockResolvedValue({ ...connected(), running: false, connected: false });

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(body.success).toBe(false);
    expect(body.warning).toBe("plugin_install_failed");
  });

  it("does not report success on a plugin install timeout", async () => {
    mockEnsurePlugin.mockResolvedValue({ ok: false, reason: "install_timeout" });
    mockWait.mockResolvedValue(null);

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(body.success).toBe(false);
    expect(body.warning).toBe("plugin_install_timeout");
  });

  it("reports an unverifiable channel as unverified, never as connected", async () => {
    mockWait.mockResolvedValue(null);

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(body.success).toBe(false);
    expect(body.warning).toBe("channel_unverified");
  });

  it("keeps restart_pending ahead of the states a dead gateway explains", async () => {
    mockRestart.mockRejectedValue(new Error("systemctl: failed"));
    mockWait.mockResolvedValue({ ...connected(), running: false, connected: false });

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(body.success).toBe(false);
    expect(body.restarted).toBe(false);
    expect(body.warning).toBe("restart_pending");
  });

  it("refuses an unresolvable token reference without restarting anything", async () => {
    // The writer throws rather than putting a reference on disk that the
    // gateway cannot resolve. Live, that config crash-looped the gateway and
    // tripped the breaker that suppresses every channel — so the route must not
    // "carry on and let the probe report it", it must stop.
    mockSetDiscordToken.mockRejectedValue(new EnvSecretProviderConflictError("default", "file"));

    const res = await POST(req({ botToken: TOKEN }));
    const body = await res.json();

    expect(body).toMatchObject({
      success: false,
      code: "token_unresolved",
      warning: "token_unresolved",
      restarted: false,
    });
    expect(mockRestart).not.toHaveBeenCalled();
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("does not leak the refusal's internals to the client", async () => {
    mockSetDiscordToken.mockRejectedValue(new EnvSecretProviderConflictError("default", "exec"));

    const body = await (await POST(req({ botToken: TOKEN }))).json();

    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body.error).toBeUndefined();
  });

  it("leaves the Hermes path alone — it has no openclaw CLI to install into", async () => {
    mockHarness.mockResolvedValue("hermes");
    const { setHermesDiscordAllowlist, ensureHermesGateway } = await import("@/lib/hermes-discord");
    vi.mocked(setHermesDiscordAllowlist).mockResolvedValue({
      allowedUsers: [OWNER_ID],
      changedKeys: ["DISCORD_ALLOWED_USERS"],
      authorized: true,
    });
    vi.mocked(ensureHermesGateway).mockResolvedValue({
      installed: true,
      running: true,
      scope: "system",
      applied: true,
    });

    const body = await (await POST(req({ botToken: TOKEN, allowedUserIds: [OWNER_ID] }))).json();

    expect(mockEnsurePlugin).not.toHaveBeenCalled();
    expect(body.success).toBe(true);
  });
});
