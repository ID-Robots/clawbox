import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `src/lib/openclaw-channels.ts` — the configure-time channel plugin installer
 * and the channel status reader.
 *
 * WHY THIS EXISTS AT ALL. OpenClaw's stock extensions ship exactly two
 * messaging channels, imessage and telegram. Discord and WhatsApp are official
 * plugins published to npm, and a device that has never installed one logs
 *
 *     channels.discord is configured but no channel plugin is installed or
 *     loadable (no-channel-owner)
 *
 * while ClawBox's Discord panel reported a successful save. Everything below is
 * about closing that gap at CONFIGURE time — see the module header for why not
 * at install time.
 */

vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>(
    "@/lib/openclaw-config",
  );
  return { ...actual, spawnOpenclawCli: vi.fn() };
});

import { spawnOpenclawCli } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(spawnOpenclawCli);

/** `plugins list --json` output with the given plugin ids present and enabled. */
function pluginsListJson(entries: { id: string; channelIds?: string[]; enabled?: boolean }[]) {
  return JSON.stringify(
    entries.map((e) => ({
      id: e.id,
      channelIds: e.channelIds ?? [e.id],
      enabled: e.enabled ?? true,
      status: (e.enabled ?? true) ? "enabled" : "disabled",
    })),
  );
}

/** `channels status --json` output for one account of one channel. */
function channelStatusJson(channel: string, account: Record<string, unknown>) {
  return JSON.stringify({
    channels: { [channel]: { configured: true, running: account.running ?? false } },
    channelAccounts: { [channel]: [{ accountId: "default", ...account }] },
  });
}

describe("ensureChannelPlugin", () => {
  let lib: typeof import("@/lib/openclaw-channels");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    lib = await import("@/lib/openclaw-channels");
  });

  it("is a no-op when the channel's plugin is already installed", async () => {
    mockSpawn.mockResolvedValueOnce(pluginsListJson([{ id: "discord" }]));

    const result = await lib.ensureChannelPlugin("discord");

    expect(result).toEqual({ ok: true, installed: false });
    // One call — the probe. Nothing was installed.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toEqual(["plugins", "list", "--json"]);
  });

  it("installs the official npm plugin when the channel has none", async () => {
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "telegram" }]))
      .mockResolvedValueOnce("Installed plugin: discord.");

    const result = await lib.ensureChannelPlugin("discord");

    expect(result).toEqual({ ok: true, installed: true });
    expect(mockSpawn.mock.calls[1][0]).toEqual(["plugins", "install", "@openclaw/discord"]);
  });

  it("installs the WhatsApp plugin the same way — nothing is special-cased to Discord", async () => {
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "telegram" }]))
      .mockResolvedValueOnce("Installed plugin: whatsapp.");

    const result = await lib.ensureChannelPlugin("whatsapp");

    expect(result).toEqual({ ok: true, installed: true });
    expect(mockSpawn.mock.calls[1][0]).toEqual(["plugins", "install", "@openclaw/whatsapp"]);
  });

  it("matches a plugin that OWNS the channel under a different plugin id", async () => {
    // The registry keys plugins by their own id; the channel they own is in
    // `channelIds`. Matching on the plugin id alone would reinstall forever.
    mockSpawn.mockResolvedValueOnce(
      pluginsListJson([{ id: "openclaw-discord", channelIds: ["discord"] }]),
    );

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: false });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("enables a plugin that is installed but disabled", async () => {
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "discord", enabled: false }]))
      .mockResolvedValueOnce("Enabled plugin: discord");

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: false });
    expect(mockSpawn.mock.calls[1][0]).toEqual(["plugins", "enable", "discord"]);
  });

  it("reports install_failed rather than throwing", async () => {
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([]))
      .mockRejectedValueOnce(new Error("npm ERR! network"));

    expect(await lib.ensureChannelPlugin("discord")).toEqual({
      ok: false,
      reason: "install_failed",
    });
  });

  it("reports install_timeout distinctly — a slow network is not a broken box", async () => {
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([]))
      .mockRejectedValueOnce(new Error("/usr/bin/openclaw plugins install timed out after 180000ms"));

    expect(await lib.ensureChannelPlugin("discord")).toEqual({
      ok: false,
      reason: "install_timeout",
    });
  });

  it("refuses a channel it has no official plugin for", async () => {
    expect(await lib.ensureChannelPlugin("carrier-pigeon")).toEqual({
      ok: false,
      reason: "unsupported_channel",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("treats an unreadable plugin registry as 'not installed' and installs", async () => {
    mockSpawn.mockResolvedValueOnce("not json at all").mockResolvedValueOnce("ok");

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: true });
  });
});

describe("readChannelStatus", () => {
  let lib: typeof import("@/lib/openclaw-channels");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    lib = await import("@/lib/openclaw-channels");
  });

  it("reads the account row the gateway publishes, and nothing a probe would add", async () => {
    // The `bot` key below is what `channels status --probe` adds; a plain
    // `channels status` never emits it. Verified against a live connected bot
    // (192.168.50.71), whose un-probed account row carries exactly:
    //   accountId, configured, connected, enabled, lastConnectedAt,
    //   lastDisconnect, lastError, lastEventAt, lastInboundAt, lastOutboundAt,
    //   lastStartAt, lastStopAt, lastTransportActivityAt, reconnectAttempts,
    //   restartPending, running, tokenSource, tokenStatus
    // — no `bot`, no `probe`.
    //
    // It is included here anyway to pin that ChannelStatus does NOT grow a
    // field out of it. A mapped `botUsername` looked useful and was dead: this
    // function is never called with --probe, so it was always null, and the
    // status route's fallback onto it was unreachable code behind a test that
    // only passed because its own fixture invented the value.
    mockSpawn.mockResolvedValueOnce(
      channelStatusJson("discord", {
        configured: true,
        running: true,
        connected: true,
        tokenStatus: "available",
        restartPending: false,
        lastError: null,
        bot: { username: "HermesBotTest" },
      }),
    );

    expect(await lib.readChannelStatus("discord")).toEqual({
      configured: true,
      running: true,
      connected: true,
      tokenStatus: "available",
      restartPending: false,
      lastError: null,
    });
  });

  it("returns null when the CLI times out — never a fabricated 'connected'", async () => {
    mockSpawn.mockRejectedValueOnce(new Error("timed out after 25000ms"));

    expect(await lib.readChannelStatus("discord")).toBeNull();
  });

  it("returns null when the gateway knows nothing about the channel", async () => {
    mockSpawn.mockResolvedValueOnce(JSON.stringify({ channels: {}, channelAccounts: {} }));

    expect(await lib.readChannelStatus("discord")).toBeNull();
  });

  it("falls back to the channel-level row when no account row exists", async () => {
    mockSpawn.mockResolvedValueOnce(
      JSON.stringify({
        channels: { discord: { configured: true, running: true, lastError: null } },
      }),
    );

    const status = await lib.readChannelStatus("discord");
    expect(status).toMatchObject({ configured: true, running: true });
    // No account row means no `connected` field. Absent must not read as true.
    expect(status?.connected).toBe(false);
  });

  it("passes a bounded --timeout to the CLI so a wedged gateway cannot hang the panel", async () => {
    mockSpawn.mockResolvedValueOnce(channelStatusJson("discord", { running: true }));

    await lib.readChannelStatus("discord");

    const args = mockSpawn.mock.calls[0][0];
    expect(args).toContain("--json");
    expect(args).toContain("--timeout");
    const timeout = Number(args[args.indexOf("--timeout") + 1]);
    expect(timeout).toBeGreaterThan(0);
  });
});

describe("waitForChannelConnected", () => {
  let lib: typeof import("@/lib/openclaw-channels");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    lib = await import("@/lib/openclaw-channels");
  });

  it("returns as soon as the channel is connected", async () => {
    mockSpawn.mockResolvedValueOnce(
      channelStatusJson("discord", { running: true, connected: true, tokenStatus: "available" }),
    );

    const status = await lib.waitForChannelConnected("discord", { attempts: 3, delayMs: 0 });

    expect(status?.connected).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("retries a channel that has not come up yet, then gives up honestly", async () => {
    mockSpawn.mockResolvedValue(channelStatusJson("discord", { running: false, connected: false }));

    const status = await lib.waitForChannelConnected("discord", { attempts: 3, delayMs: 0 });

    expect(status?.connected).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it("stops early on an unresolvable token — retrying cannot fix a missing secret", async () => {
    mockSpawn.mockResolvedValue(
      channelStatusJson("discord", {
        running: false,
        connected: false,
        tokenStatus: "configured_unavailable",
      }),
    );

    const status = await lib.waitForChannelConnected("discord", { attempts: 3, delayMs: 0 });

    expect(status?.tokenStatus).toBe("configured_unavailable");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
