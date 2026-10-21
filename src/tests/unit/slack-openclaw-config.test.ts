import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs/promises";

// The OpenClaw leg of the Slack integration is config generation, so these
// assertions are its verification:
//
//   1. both tokens are env REFERENCES in openclaw.json, with the provider that
//      resolves them, and the values land in data/slack.env at 0600 — the shape
//      the pinned plugin documents as its "Recommended SecretRef setup";
//   2. Socket Mode is the only mode written, and no open DM policy survives a
//      save.

vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
    rm: vi.fn(),
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

// Placeholders in Slack's published shapes, assembled so no literal token
// pattern sits in the source.
const BOT = ["xoxb", "000000000000", "000000000000", "clawboxtestnotreal"].join("-");
const APP = ["xapp", "1", "A000000000", "000000000000", "clawboxtestnotreal"].join("-");

type WriteCall = [string, string, unknown];

function writtenJsonConfig(): Record<string, unknown> & {
  channels: Record<string, Record<string, unknown>>;
  secrets?: { providers?: Record<string, unknown> };
  plugins?: { entries?: Record<string, Record<string, unknown>> };
} {
  const call = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) =>
    String(c[0]).endsWith("openclaw.json.tmp"),
  );
  if (!call) throw new Error("openclaw.json was not written");
  return JSON.parse(call[1]);
}

function writtenEnvFile(): { path: string; body: string; options: unknown } | null {
  const call = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) =>
    String(c[0]).includes("slack.env"),
  );
  return call ? { path: String(call[0]), body: call[1], options: call[2] } : null;
}

describe("setSlackTokens (OpenClaw config generation)", () => {
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

  it("writes both tokens as env references in Socket Mode", async () => {
    await openclawConfig.setSlackTokens(BOT, APP);
    const config = writtenJsonConfig();
    expect(config.channels.slack).toEqual({
      enabled: true,
      mode: "socket",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    });
    // The reference is only resolvable through a provider; envSecretRef
    // installs it in the same write.
    expect(config.secrets?.providers?.default).toEqual({ source: "env" });
    expect(config.plugins?.entries?.slack).toMatchObject({ enabled: true });
    expect(JSON.stringify(config)).not.toContain(BOT);
    expect(JSON.stringify(config)).not.toContain(APP);
  });

  it("puts the values in data/slack.env at 0600, after the config", async () => {
    await openclawConfig.setSlackTokens(BOT, APP);
    const env = writtenEnvFile();
    expect(env).not.toBeNull();
    expect(env!.path).toMatch(/data\/slack\.env\.tmp$/);
    expect(env!.body).toContain(`SLACK_BOT_TOKEN=${BOT}\n`);
    expect(env!.body).toContain(`SLACK_APP_TOKEN=${APP}\n`);
    expect(env!.options).toMatchObject({ mode: 0o600 });
    expect(mockFs.chmod).toHaveBeenCalledWith(expect.stringMatching(/slack\.env\.tmp$/), 0o600);
    expect(mockFs.rename).toHaveBeenCalledWith(
      expect.stringMatching(/slack\.env\.tmp$/),
      expect.stringMatching(/data\/slack\.env$/),
    );
    const calls = mockFs.writeFile.mock.calls as unknown as WriteCall[];
    const configAt = calls.findIndex((c) => String(c[0]).endsWith("openclaw.json.tmp"));
    const envAt = calls.findIndex((c) => String(c[0]).includes("slack.env"));
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(envAt).toBeGreaterThan(configAt);
  });

  it("keeps the owner's own keys and a specific allowlist, drops open DM access and literals", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        channels: {
          slack: {
            enabled: false,
            mode: "http",
            botToken: "literal-left-by-hand",
            appToken: "literal-left-by-hand",
            requireMention: true,
            dmPolicy: "open",
            allowFrom: ["*", "U0123456789"],
          },
        },
      }),
    );
    await openclawConfig.setSlackTokens(BOT, APP);
    const slack = writtenJsonConfig().channels.slack;
    expect(slack.enabled).toBe(true);
    expect(slack.mode).toBe("socket");
    expect(slack.requireMention).toBe(true);
    expect(slack.dmPolicy).toBeUndefined();
    expect(slack.allowFrom).toEqual(["U0123456789"]);
    expect(slack.botToken).toEqual({ source: "env", provider: "default", id: "SLACK_BOT_TOKEN" });
  });

  it("keeps a hand-written allowlist policy", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ channels: { slack: { dmPolicy: "allowlist", allowFrom: ["U0123456789"] } } }),
    );
    await openclawConfig.setSlackTokens(BOT, APP);
    const slack = writtenJsonConfig().channels.slack;
    expect(slack.dmPolicy).toBe("allowlist");
    expect(slack.allowFrom).toEqual(["U0123456789"]);
  });

  it("drops allowFrom entirely when it only held the wildcard", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ channels: { slack: { allowFrom: ["*"] } } }));
    await openclawConfig.setSlackTokens(BOT, APP);
    expect(writtenJsonConfig().channels.slack).not.toHaveProperty("allowFrom");
  });

  it("refuses an unsafe value before writing anything", async () => {
    await expect(openclawConfig.setSlackTokens(`${BOT}\nEVIL=1`, APP)).rejects.toThrow(/unsafe/);
    await expect(openclawConfig.setSlackTokens(BOT, "-flag")).rejects.toThrow(/unsafe/);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("refuses a secrets provider it does not own and writes nothing", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ secrets: { providers: { default: { source: "file", path: "/x" } } } }),
    );
    await expect(openclawConfig.setSlackTokens(BOT, APP)).rejects.toBeInstanceOf(
      openclawConfig.EnvSecretProviderConflictError,
    );
    expect(writtenEnvFile()).toBeNull();
  });
});

describe("isSafeGatewayEnvValue", () => {
  it("accepts Slack and Azure credential shapes and refuses line breakers", async () => {
    const { isSafeGatewayEnvValue } = await import("@/lib/openclaw-config");
    expect(isSafeGatewayEnvValue(BOT)).toBe(true);
    expect(isSafeGatewayEnvValue(APP)).toBe(true);
    expect(isSafeGatewayEnvValue("abc~DEF.ghi_jkl-123")).toBe(true);
    for (const bad of ["", "a b", "a\nb", "a\"b", "a'b", "a$b", "a\\b", "a#b", "-leading"]) {
      expect(isSafeGatewayEnvValue(bad)).toBe(false);
    }
  });
});

describe("approveChannelPairing", () => {
  it("only approves on a guided channel, and only a well-formed code", async () => {
    const { approveChannelPairing } = await import("@/lib/openclaw-config");
    await expect(approveChannelPairing("telegram", "ABCD2345")).rejects.toThrow(/Unsupported/);
    await expect(approveChannelPairing("--help", "ABCD2345")).rejects.toThrow(/Unsupported/);
    await expect(approveChannelPairing("slack", "bad")).rejects.toThrow(/Invalid pairing code/);
    await expect(approveChannelPairing("slack", "ABCD234!")).rejects.toThrow(/Invalid pairing code/);
  });
});
