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

function writtenJsonConfig(): Record<string, never> & {
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
    ["a newline that would append a second assignment", "
DISCORD_ALLOW_ALL_USERS=true"],
    ["a carriage return", "DISCORD_ALLOW_ALL_USERS=true"],
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
      .writeDiscordGatewayEnv(`${TOKEN}
DISCORD_ALLOW_ALL_USERS=true`)
      .catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it("still writes a well-formed token", async () => {
    await openclawConfig.writeDiscordGatewayEnv(TOKEN);
    expect(writtenEnvFile().body).toContain(`DISCORD_BOT_TOKEN=${TOKEN}`);
  });
});
