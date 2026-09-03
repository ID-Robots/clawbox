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
  return {
    ...actual,
    // Pinned rather than inherited: the real one reads the edition off disk and
    // falls back to process.env, so a CI runner with CLAWBOX_EDITION=hermes
    // would make readChannelStatus short-circuit and these tests assert nothing.
    openclawIsAbsent: () => false,
    spawnOpenclawCli: vi.fn(),
    readConfig: vi.fn(),
  };
});

import { OpenclawSpawnTimeoutError, readConfig, spawnOpenclawCli } from "@/lib/openclaw-config";

const mockSpawn = vi.mocked(spawnOpenclawCli);
const mockReadConfig = vi.mocked(readConfig);

/** openclaw.json with the given plugin ids switched on in `plugins.entries`. */
function configWithEnabled(...ids: string[]) {
  return { plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) } };
}

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
    // Default: the gateway config already carries the entry, so the common path
    // does not shell out to `plugins enable`.
    mockReadConfig.mockResolvedValue(configWithEnabled("discord", "whatsapp"));
    lib = await import("@/lib/openclaw-channels");
  });

  it("is a no-op when the plugin is installed AND switched on in the config", async () => {
    mockSpawn.mockResolvedValueOnce(pluginsListJson([{ id: "discord" }]));

    const result = await lib.ensureChannelPlugin("discord");

    expect(result).toEqual({ ok: true, installed: false });
    // One call — the probe. Nothing was installed and nothing was enabled.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toEqual(["plugins", "list", "--json"]);
  });

  it("enables a plugin the GATEWAY CONFIG does not carry, however `plugins list` describes it", async () => {
    // The live regression. `plugins list --json` reported the package as
    // {enabled: true, status: "loaded"} — its discovery default — while
    // openclaw.json had no plugins.entries.discord, and the gateway brought up
    // no Discord channel at all. Trusting the CLI's field here is what let a
    // second save report a plugin that was never loaded.
    mockReadConfig.mockResolvedValue(configWithEnabled());
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "discord", enabled: true }]))
      .mockResolvedValueOnce('Enabled plugin "discord". Restart the gateway to apply.');

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: false });
    expect(mockSpawn.mock.calls[1][0]).toEqual(["plugins", "enable", "discord"]);
  });

  it("enables under the OWNING plugin's id, not the channel's", async () => {
    mockReadConfig.mockResolvedValue(configWithEnabled());
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "openclaw-discord", channelIds: ["discord"] }]))
      .mockResolvedValueOnce("ok");

    await lib.ensureChannelPlugin("discord");

    expect(mockSpawn.mock.calls[1][0]).toEqual(["plugins", "enable", "openclaw-discord"]);
  });

  it("reports install_failed when the enable fails", async () => {
    mockReadConfig.mockResolvedValue(configWithEnabled());
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "discord" }]))
      .mockRejectedValueOnce(new Error("config write refused"));

    expect(await lib.ensureChannelPlugin("discord")).toEqual({
      ok: false,
      reason: "install_failed",
    });
  });

  it("installs the official npm plugin when the channel has none", async () => {
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "telegram" }]))
      .mockResolvedValueOnce("Installed plugin: discord.");

    const result = await lib.ensureChannelPlugin("discord");

    expect(result).toEqual({ ok: true, installed: true });
    expect(mockSpawn.mock.calls[1][0]).toEqual(["plugins", "install", "@openclaw/discord"]);
    // `plugins install` writes plugins.entries.<id> itself, so no second write.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("still switches a freshly installed plugin on if the installer left no entry", async () => {
    mockReadConfig.mockResolvedValue(configWithEnabled());
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "telegram" }]))
      .mockResolvedValueOnce("Installed plugin: discord.")
      .mockResolvedValueOnce("ok");

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: true });
    expect(mockSpawn.mock.calls[2][0]).toEqual(["plugins", "enable", "discord"]);
  });

  it("treats OpenClaw's 'plugin already exists' refusal as installed, not as a failure", async () => {
    // Live on 192.168.50.82. `plugins list` reads a PERSISTED registry
    // snapshot, so a plugin that is in OpenClaw's own store but missing from
    // that snapshot is invisible to the pre-check above. The install then hits
    //
    //   plugin already exists: ~/.openclaw/npm/projects/openclaw-discord-…/
    //   node_modules/@openclaw/discord (delete it first)
    //
    // on stderr with exit 1. Reporting that as install_failed blocked a save
    // whose plugin was present and working — the same dishonesty this module
    // exists to remove, only inverted. The package being on disk IS the
    // outcome we asked for, and whether it actually serves the channel is
    // settled afterwards by the live connectivity probe, not guessed here.
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "telegram" }]))
      .mockRejectedValueOnce(
        new Error(
          "plugin already exists: /home/clawbox/.openclaw/npm/projects/openclaw-discord-c0892df945/node_modules/@openclaw/discord (delete it first)",
        ),
      );

    // Not `installed: true` — this call did not install it, it found it.
    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: false });
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
    mockReadConfig.mockResolvedValue(configWithEnabled("openclaw-discord"));
    mockSpawn.mockResolvedValueOnce(
      pluginsListJson([{ id: "openclaw-discord", channelIds: ["discord"] }]),
    );

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: false });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
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
    // The TYPE, not the sentence: `spawnOpenclaw` rejects
    // OpenclawSpawnTimeoutError when it kills a child at its deadline, and a
    // plain Error carrying the same words is any other failure. Matching the
    // message let a reworded timeout downgrade the owner's remediation to
    // "install failed" — and a message that merely mentioned a timeout upgrade
    // it the other way.
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([]))
      .mockRejectedValueOnce(
        new OpenclawSpawnTimeoutError("/usr/bin/openclaw plugins install timed out after 180000ms"),
      );

    expect(await lib.ensureChannelPlugin("discord")).toEqual({
      ok: false,
      reason: "install_timeout",
    });
  });

  it("settles a plugins enable killed at its deadline by the config, not by the kill", async () => {
    // D-12's shape, one CLI verb over. `plugins enable` writes
    // `plugins.entries.<id>.enabled` and then spends seconds loading the
    // gateway SDK, so on a Jetson the entry lands inside the 45 s window we
    // kill in — and the owner was told the channel plugin could not be
    // installed while it was enabled on disk and live after the next restart.
    mockReadConfig
      .mockResolvedValueOnce(configWithEnabled()) // the precondition: not on yet
      .mockResolvedValueOnce(configWithEnabled("discord")); // the read-back after the kill
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "discord" }]))
      .mockRejectedValueOnce(
        new OpenclawSpawnTimeoutError("/usr/bin/openclaw plugins enable discord timed out after 45000ms"),
      );

    expect(await lib.ensureChannelPlugin("discord")).toEqual({ ok: true, installed: false });
  });

  it("still fails a killed plugins enable whose entry never reached the config", async () => {
    // The other half: forgiving a kill the config does not corroborate would
    // swap this module's false failure for a false success, and the owner would
    // be shown a channel that the gateway never loads.
    mockReadConfig.mockResolvedValue(configWithEnabled());
    mockSpawn
      .mockResolvedValueOnce(pluginsListJson([{ id: "discord" }]))
      .mockRejectedValueOnce(
        new OpenclawSpawnTimeoutError("/usr/bin/openclaw plugins enable discord timed out after 45000ms"),
      );

    expect(await lib.ensureChannelPlugin("discord")).toEqual({
      ok: false,
      reason: "install_failed",
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
    // Default: the gateway config already carries the entry, so the common path
    // does not shell out to `plugins enable`.
    mockReadConfig.mockResolvedValue(configWithEnabled("discord", "whatsapp"));
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
    // Default: the gateway config already carries the entry, so the common path
    // does not shell out to `plugins enable`.
    mockReadConfig.mockResolvedValue(configWithEnabled("discord", "whatsapp"));
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
