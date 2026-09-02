import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs/promises";

// The OpenClaw leg of the Discord integration is pure config generation — the
// gateway is masked on the bench box, so these assertions ARE the verification.
// Two things must hold and neither is obvious from reading the route:
//
//   1. the credential is written as an env REFERENCE plus a real env file. A
//      literal `botToken` (the Telegram shape) would validate and start, and
//      the bot would silently never log in.
//   2. `dmPolicy`/`allowFrom` are never written. OpenClaw defaults to pairing;
//      writing "open"/["*"] would expose the agent's shell/file/power tools to
//      anyone who finds the bot.

vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
  },
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

const mockFs = vi.mocked(fs);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

type WriteCall = [string, string, unknown];

function writtenJsonConfig(): Record<string, unknown> & {
  channels: Record<string, Record<string, unknown>>;
} {
  const call = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) =>
    String(c[0]).endsWith("openclaw.json.tmp"),
  );
  if (!call) throw new Error("openclaw.json was not written");
  return JSON.parse(call[1]);
}

function writtenEnvFile(): { path: string; body: string; options: unknown } {
  const call = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) =>
    String(c[0]).includes("discord.env"),
  );
  if (!call) throw new Error("discord.env was not written");
  return { path: String(call[0]), body: call[1], options: call[2] };
}

describe("setDiscordToken (OpenClaw config generation)", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  it("writes the credential as an env reference, not a literal", async () => {
    await openclawConfig.setDiscordToken(TOKEN);

    const config = writtenJsonConfig();
    expect(config.channels.discord).toMatchObject({
      enabled: true,
      token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
    });
    // The token itself must not be anywhere in openclaw.json.
    expect(config.channels.discord).not.toHaveProperty("botToken");
    const jsonCall = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) =>
      String(c[0]).endsWith("openclaw.json.tmp"),
    );
    expect(jsonCall?.[1]).not.toContain(TOKEN);
  });

  it("never writes dmPolicy or allowFrom", async () => {
    await openclawConfig.setDiscordToken(TOKEN);
    const discord = writtenJsonConfig().channels.discord;
    expect(discord).not.toHaveProperty("dmPolicy");
    expect(discord).not.toHaveProperty("allowFrom");
  });

  it("re-secures a channel an older build left open", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        channels: {
          discord: { enabled: true, dmPolicy: "open", allowFrom: ["*"], botToken: "stale" },
        },
      }),
    );

    await openclawConfig.setDiscordToken(TOKEN);

    const discord = writtenJsonConfig().channels.discord;
    expect(discord).not.toHaveProperty("dmPolicy");
    expect(discord).not.toHaveProperty("allowFrom");
    // A stale literal token must not outlive the switch to the env reference.
    expect(discord).not.toHaveProperty("botToken");
  });

  it("writes nothing OpenClaw's schema has not been confirmed to accept", async () => {
    // One out-of-schema value invalidates the WHOLE config and the gateway
    // loads no channels at all — a Discord guess would take Telegram down too.
    await openclawConfig.setDiscordToken(TOKEN);
    expect(Object.keys(writtenJsonConfig().channels.discord).sort()).toEqual(["enabled", "token"]);
  });

  it("leaves the rest of the config, including Telegram, untouched", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        gateway: { port: 18789 },
        channels: { telegram: { enabled: true, botToken: "123:abc" } },
      }),
    );

    await openclawConfig.setDiscordToken(TOKEN);

    const config = writtenJsonConfig();
    expect(config.gateway).toEqual({ port: 18789 });
    expect(config.channels.telegram).toEqual({ enabled: true, botToken: "123:abc" });
  });

  it("puts the token in the gateway EnvironmentFile at 0600", async () => {
    await openclawConfig.setDiscordToken(TOKEN);

    const env = writtenEnvFile();
    expect(env.path.endsWith("discord.env.tmp")).toBe(true);
    expect(env.body).toContain(`DISCORD_BOT_TOKEN=${TOKEN}`);
    expect(env.options).toMatchObject({ mode: 0o600 });
    // writeFile's mode is ignored when the file already exists, so the explicit
    // chmod is what keeps a pre-existing 0644 from surviving a rewrite.
    expect(mockFs.chmod).toHaveBeenCalledWith(expect.stringContaining("discord.env.tmp"), 0o600);
    expect(mockFs.rename).toHaveBeenCalledWith(
      expect.stringContaining("discord.env.tmp"),
      openclawConfig.DISCORD_ENV_PATH,
    );
  });

  it("writes exactly one env line, so the file cannot grow extra assignments", async () => {
    await openclawConfig.setDiscordToken(TOKEN);
    const assignments = writtenEnvFile()
      .body.split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));
    expect(assignments).toEqual([`DISCORD_BOT_TOKEN=${TOKEN}`]);
  });
});

// `writeDiscordGatewayEnv` is exported, and the line it writes is interpolated
// unquoted. That is only safe while the token cannot carry a newline or a
// quote, so the writer enforces the charset itself instead of trusting the
// configure route to have done it — a guarantee that survives a future caller
// which forgets.
describe("writeDiscordGatewayEnv (env-file injection guard)", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  const UNSAFE = [
    // The payload that matters: a second assignment that would open the bot to
    // everyone who can find the server.
    ["a newline that would append a second assignment", "\nDISCORD_ALLOW_ALL_USERS=true"],
    ["a carriage return", "\rDISCORD_ALLOW_ALL_USERS=true"],
    ["a quote that would escape the value", '"'],
    ["a shell substitution", "$(id)"],
  ] as const;

  it.each(UNSAFE)("refuses a token containing %s and writes nothing", async (_why, suffix) => {
    await expect(openclawConfig.writeDiscordGatewayEnv(`${TOKEN}${suffix}`)).rejects.toThrow();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockFs.rename).not.toHaveBeenCalled();
  });

  it("does not leak the rejected token into the error message", async () => {
    const err = (await openclawConfig
      .writeDiscordGatewayEnv(`${TOKEN}\nDISCORD_ALLOW_ALL_USERS=true`)
      .catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it("still writes a well-formed token", async () => {
    await openclawConfig.writeDiscordGatewayEnv(TOKEN);
    expect(writtenEnvFile().body).toContain(`DISCORD_BOT_TOKEN=${TOKEN}`);
  });
});

// Plugin TRUST, which is a separate fact from plugin INSTALLATION.
//
// `openclaw plugins install @openclaw/discord` puts the package in OpenClaw's
// own store and writes `plugins.entries.discord`. But that entry is the only
// thing that makes the gateway TRUST an external plugin, and it lives in the
// same openclaw.json that every other ClawBox route read-modify-writes. Any
// route that read the file before the save and wrote it after silently drops
// the entry, and the gateway then refuses the channel:
//
//   channels.discord: channel is configured, but external plugin "discord" is
//   installed without explicit trust. Add plugins.entries.discord.enabled=true.
//
// Observed on 192.168.50.82: Discord connected at 09:56:37, a config write at
// 09:58:48 dropped `plugins.entries.discord`, and every `channels status` from
// then on answered `unknown channel: discord` while the panel showed the card
// as "unknown". Restoring the entry brought the channel straight back to
// connected, across a full gateway restart.
//
// So the entry is written HERE, in the same atomic write as the channel block,
// rather than being left to survive on its own.
describe("channel plugin trust", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  it("trusts the discord plugin in the same write as the channel", async () => {
    await openclawConfig.setDiscordToken(TOKEN);

    const written = writtenJsonConfig() as unknown as {
      plugins?: { entries?: Record<string, { enabled?: boolean }> };
      channels: Record<string, unknown>;
    };
    expect(written.plugins?.entries?.discord).toEqual({ enabled: true });
    // Same write, so the two cannot be separated by a concurrent writer.
    expect(written.channels.discord).toBeDefined();
  });

  it("leaves other plugin entries, and the rest of the entry, alone", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        plugins: {
          entries: {
            anthropic: { enabled: true },
            discord: { enabled: false, someOperatorKey: "keep me" },
          },
        },
      }),
    );

    await openclawConfig.setDiscordToken(TOKEN);

    const entries = (writtenJsonConfig() as unknown as {
      plugins: { entries: Record<string, Record<string, unknown>> };
    }).plugins.entries;
    expect(entries.anthropic).toEqual({ enabled: true });
    // Flipped to trusted, without discarding what the operator put beside it.
    expect(entries.discord).toEqual({ enabled: true, someOperatorKey: "keep me" });
  });
});

// The other half of the env-reference story, and the half that was missing.
//
// `token: {source:"env", provider:"default", id:"…"}` is resolved by OpenClaw
// through `secrets.providers["default"]`. There is NO implicit default provider
// in the runtime, so a config that carries the reference and no provider block
// starts the channel and then kills it on first use with
//
//   Discord bot token configured for account "default" is unavailable; resolve
//   SecretRefs against the active runtime snapshot before using this account.
//
// Proven live: adding secrets.providers.default = { source: "env" } and
// restarting fixed a box that had been in that restart loop.
describe("env SecretRef provider (the chokepoint)", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  it("writes the provider the reference resolves through", async () => {
    await openclawConfig.setDiscordToken(TOKEN);
    expect(writtenJsonConfig().secrets).toEqual({ providers: { default: { source: "env" } } });
  });

  it("is one helper, so every future env-backed channel gets it too", async () => {
    // Not a Discord special case: the helper that mints an env SecretRef is
    // what installs the provider, so WhatsApp/Slack/anything added later
    // cannot repeat this bug by forgetting a second write.
    const config: import("@/lib/openclaw-config").OpenClawConfig = {};
    const ref = openclawConfig.envSecretRef(config, "WHATSAPP_TOKEN");

    expect(ref).toEqual({ source: "env", provider: "default", id: "WHATSAPP_TOKEN" });
    expect(config.secrets).toEqual({ providers: { default: { source: "env" } } });
  });

  it("leaves an operator's own providers alone", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ secrets: { providers: { vault: { source: "exec" } } } }),
    );

    await openclawConfig.setDiscordToken(TOKEN);

    expect(writtenJsonConfig().secrets).toEqual({
      providers: { vault: { source: "exec" }, default: { source: "env" } },
    });
  });

  it("refuses, and writes NOTHING, when the provider cannot resolve an env ref", async () => {
    // `secrets.providers` is shared config and the entry is not ours to
    // repoint — silently turning a file-backed provider into an env-backed one
    // because Discord wanted that would break whatever else resolved through
    // it (the same shape as the authMode-only guard that broke Google in #532).
    //
    // Writing the reference anyway is not the safe fallback either: it produces
    // a channel that is configured, enabled and cannot start — the exact state
    // this change exists to remove — on a box whose other secrets resolve fine.
    // So the write is refused before it reaches disk.
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ secrets: { providers: { default: { source: "file", path: "/run/secrets" } } } }),
    );

    await expect(openclawConfig.setDiscordToken(TOKEN)).rejects.toBeInstanceOf(
      openclawConfig.EnvSecretProviderConflictError,
    );

    // Neither the config nor the credential file was touched: a half-applied
    // save here is an outage for channels that were working.
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockFs.rename).not.toHaveBeenCalled();
  });

  it("does not name the token in the refusal", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ secrets: { providers: { default: { source: "exec" } } } }),
    );

    const err = (await openclawConfig.setDiscordToken(TOKEN).catch((e: Error) => e)) as Error;

    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("exec");
  });
});

// The config comes off disk, so `secrets` can be any JSON at all. None of these
// shapes may reach a property access that throws — the caller handles the typed
// refusal and turns it into `token_unresolved`; a TypeError becomes an opaque
// 500 halfway through a save.
describe("envSecretRef against a malformed config", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  const MALFORMED = [
    ["secrets is a string", { secrets: "nope" }],
    ["secrets is an array", { secrets: [] }],
    ["providers is a string", { secrets: { providers: "nope" } }],
    ["the provider entry is null", { secrets: { providers: { default: null } } }],
    ["the provider entry is an array", { secrets: { providers: { default: [] } } }],
  ] as const;

  it.each(MALFORMED)("refuses when %s, and writes nothing", async (_why, config) => {
    mockFs.readFile.mockResolvedValue(JSON.stringify(config));

    await expect(openclawConfig.setDiscordToken(TOKEN)).rejects.toBeInstanceOf(
      openclawConfig.EnvSecretProviderConflictError,
    );
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("still accepts a config whose secrets block is simply absent", async () => {
    mockFs.readFile.mockResolvedValue("{}");
    await openclawConfig.setDiscordToken(TOKEN);
    expect(writtenJsonConfig().secrets).toEqual({ providers: { default: { source: "env" } } });
  });
});

// A malformed CONTAINER is the same class of defect as a malformed `secrets`
// value, and it fails far more quietly.
//
// `??=` only replaces `null`/`undefined`, so `"plugins": []` sails straight
// through it, and the write that follows lands somewhere harmless-looking and
// unserialisable. Two distinct things then go wrong, both silent:
//
//   1. a named property attached to an ARRAY is dropped by `JSON.stringify`,
//      which is how writeConfig reaches disk. `setDiscordToken` saves the
//      channel and the token, omits `plugins.entries.discord.enabled`, and the
//      gateway answers `unknown channel: discord` from then on while the
//      panel's card sits at "unknown" — the exact failure trustChannelPlugin's
//      doc comment exists to prevent, re-created by the helper written to
//      prevent it.
//
//   2. worse, `[].entries` is NOT nullish: it is `Array.prototype.entries`. So
//      `plugins.entries ??= {}` keeps that function, and the next line writes
//      the trust entry onto a shared JS intrinsic. In a long-lived Next.js
//      server every later `[].entries` in the process carries it. Verified:
//      after one such save, `[].entries.discord` reads `{"enabled":true}`.
//
// Every assertion here goes through the real JSON round trip and then refuses
// to read a value off a prototype — see `roundTrippedTrustEntry`. A plain
// `written.plugins?.entries?.discord` check PASSES on the broken code, because
// defect 2 puts the answer on `Array.prototype.entries`, where defect 1's empty
// array happily finds it again.
function roundTrippedTrustEntry(channelId: string): unknown {
  const plugins = (writtenJsonConfig() as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    throw new Error(`plugins did not round-trip as an object: ${JSON.stringify(plugins) ?? "undefined"}`);
  }
  const entries = (plugins as Record<string, unknown>).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(
      `plugins.entries did not round-trip as an object: ${JSON.stringify(entries) ?? "undefined"}`,
    );
  }
  return (entries as Record<string, unknown>)[channelId];
}

describe("config containers that arrive as something other than a plain object", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  // `null` already worked (`??=` does replace it); it is in the table so the
  // regression net covers every shape the operator's file can hold, not only
  // the ones that are broken today.
  const MALFORMED_PLUGINS = [
    ["plugins is an array", []],
    ["plugins is a string", "@openclaw/discord"],
    ["plugins is a number", 3],
    ["plugins is a boolean", true],
    ["plugins is null", null],
  ] as const;

  it.each(MALFORMED_PLUGINS)("still trusts the plugin when %s", async (_why, plugins) => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ plugins }));

    await openclawConfig.setDiscordToken(TOKEN);

    expect(roundTrippedTrustEntry("discord")).toEqual({ enabled: true });
  });

  const MALFORMED_ENTRIES = [
    ["entries is an array", []],
    ["entries is a string", "discord"],
    ["entries is a number", 0],
    ["entries is a boolean", false],
  ] as const;

  it.each(MALFORMED_ENTRIES)("still trusts the plugin when %s", async (_why, entries) => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ plugins: { entries } }));

    await openclawConfig.setDiscordToken(TOKEN);

    expect(roundTrippedTrustEntry("discord")).toEqual({ enabled: true });
  });

  it("still trusts the plugin when the channel's own entry is a string", async () => {
    // `{...\"on\"}` spreads to `{\"0\":\"o\",\"1\":\"n\"}`, and an unknown key in
    // plugins.entries.discord is another way to lose the gateway to 78/CONFIG.
    mockFs.readFile.mockResolvedValue(JSON.stringify({ plugins: { entries: { discord: "on" } } }));

    await openclawConfig.setDiscordToken(TOKEN);

    expect(roundTrippedTrustEntry("discord")).toEqual({ enabled: true });
  });

  it("does not write the trust entry onto Array.prototype.entries", async () => {
    // A config save has no business mutating a JS intrinsic. This is the
    // process-wide half of the array case: it outlives the request, and every
    // `[].entries` in the server sees it afterwards.
    mockFs.readFile.mockResolvedValue(JSON.stringify({ plugins: [] }));

    await openclawConfig.setDiscordToken(TOKEN);

    expect(Object.prototype.hasOwnProperty.call(Array.prototype.entries, "discord")).toBe(false);
  });

  it("keeps the operator's other plugin keys when the registry is well formed", async () => {
    // The repair must not become a reason to flatten a healthy registry.
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ plugins: { autoUpdate: false, entries: { anthropic: { enabled: true } } } }),
    );

    await openclawConfig.setDiscordToken(TOKEN);

    expect(writtenJsonConfig().plugins).toEqual({
      autoUpdate: false,
      entries: { anthropic: { enabled: true }, discord: { enabled: true } },
    });
  });

  // Same defect, same file, different container: `if (!config.channels)` is
  // false for `[]`, so the discord block is attached to an array and vanishes
  // on serialise — while `discord.env` is still written. That is a token on
  // disk for a channel nothing reads, which this module's own comments call the
  // hardest failure mode to see.
  it("still writes the channel when channels is an array", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ channels: [] }));

    await openclawConfig.setDiscordToken(TOKEN);

    const channels = writtenJsonConfig().channels;
    expect(Array.isArray(channels)).toBe(false);
    expect(channels.discord).toMatchObject({ enabled: true });
  });

  // A non-object channel block is destructured today, so its characters become
  // config keys. One out-of-schema key takes the WHOLE gateway down with exit
  // 78/CONFIG — every other channel with it.
  it("writes no stray keys when the existing discord block is a string", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ channels: { discord: "on" } }));

    await openclawConfig.setDiscordToken(TOKEN);

    expect(Object.keys(writtenJsonConfig().channels.discord).sort()).toEqual(["enabled", "token"]);
  });

  it("writes no stray keys when the existing telegram block is a string", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ channels: { telegram: "on" } }));

    await openclawConfig.setTelegramToken("123:abc");

    expect(Object.keys(writtenJsonConfig().channels.telegram).sort()).toEqual([
      "botToken",
      "enabled",
    ]);
  });

  it("still writes the control-UI origins when gateway is an array", async () => {
    // A dropped allowedOrigins list is a box that stops answering on its own
    // hostname after a rename the route reported as done.
    mockFs.readFile.mockResolvedValue(JSON.stringify({ gateway: [] }));

    await openclawConfig.setControlUiAllowedOrigins("clawbox-test");

    const written = writtenJsonConfig() as {
      gateway?: { controlUi?: { allowedOrigins?: string[] } };
    };
    expect(Array.isArray(written.gateway)).toBe(false);
    expect(written.gateway?.controlUi?.allowedOrigins).toContain("http://clawbox-test.local");
  });

  // The ROOT is a container too, and it is the one every helper stands on. A
  // file holding `[]` parses fine, so the channel, the secrets block and the
  // trust entry are all attached to an array and the write lands as `[]`.
  const MALFORMED_ROOT = [
    ["the whole file is an array", "[]"],
    ["the whole file is a string", '"nope"'],
    ["the whole file is a number", "3"],
    ["the whole file is null", "null"],
  ] as const;

  it.each(MALFORMED_ROOT)("still writes a usable config when %s", async (_why, raw) => {
    mockFs.readFile.mockResolvedValue(raw);

    await openclawConfig.setDiscordToken(TOKEN);

    const written = writtenJsonConfig();
    expect(Array.isArray(written)).toBe(false);
    expect(written.channels.discord).toMatchObject({ enabled: true });
    expect(roundTrippedTrustEntry("discord")).toEqual({ enabled: true });
  });

  // readConfigStrict answers the opposite question and must give the opposite
  // answer: it exists so a caller about to SKIP a repair is never told "already
  // clean" by a file it could not read.
  it.each(MALFORMED_ROOT)("readConfigStrict refuses when %s", async (_why, raw) => {
    mockFs.readFile.mockResolvedValue(raw);

    await expect(openclawConfig.readConfigStrict()).rejects.toThrow();
  });

  it("readConfigStrict still returns a well-formed config", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ gateway: { port: 18789 } }));

    await expect(openclawConfig.readConfigStrict()).resolves.toEqual({ gateway: { port: 18789 } });
  });

  it("keeps the rest of a well-formed gateway block", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ gateway: { port: 18789 } }));

    await openclawConfig.setControlUiAllowedOrigins("clawbox-test");

    const written = writtenJsonConfig() as { gateway?: { port?: number } };
    expect(written.gateway?.port).toBe(18789);
  });
});
