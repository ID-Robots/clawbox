import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs/promises";

// setSignalAccount writes the pinned plugin's documented shape: the bot's
// number and a managed-native transport, so the gateway supervises signal-cli
// itself. No secret is involved — and none may appear.

vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("fs/promises", () => ({
  default: { readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), rm: vi.fn() },
}));
vi.mock("fs", () => ({
  default: { readFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

const mockFs = vi.mocked(fs);
const NUMBER = "+15550000001";
const CLI = "/usr/local/bin/signal-cli";

type WriteCall = [string, string, unknown];

function written(): { channels: Record<string, Record<string, unknown>>; plugins?: { entries?: Record<string, unknown> } } {
  const call = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) =>
    String(c[0]).endsWith("openclaw.json.tmp"),
  );
  if (!call) throw new Error("openclaw.json was not written");
  return JSON.parse(call[1]);
}

describe("setSignalAccount", () => {
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

  it("writes the account with a managed-native transport and trusts the plugin", async () => {
    await openclawConfig.setSignalAccount(NUMBER, CLI);
    const config = written();
    expect(config.channels.signal).toEqual({
      enabled: true,
      account: NUMBER,
      transport: { kind: "managed-native", cliPath: CLI, startupTimeoutMs: 120_000 },
    });
    expect(config.plugins?.entries?.signal).toMatchObject({ enabled: true });
    // No env file: Signal has no secret to put in one.
    const envWrites = (mockFs.writeFile.mock.calls as unknown as WriteCall[]).filter((c) => String(c[0]).includes(".env"));
    expect(envWrites).toEqual([]);
  });

  it("keeps an owner's own startup timeout and other keys, drops open DM access", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({
        channels: {
          signal: {
            account: "+15559999999",
            historyLimit: 10,
            dmPolicy: "open",
            allowFrom: ["*"],
            transport: { kind: "managed-native", cliPath: "/old/signal-cli", startupTimeoutMs: 45_000 },
          },
        },
      }),
    );
    await openclawConfig.setSignalAccount(NUMBER, CLI);
    const signal = written().channels.signal;
    expect(signal.account).toBe(NUMBER);
    expect(signal.historyLimit).toBe(10);
    expect(signal.dmPolicy).toBeUndefined();
    expect(signal.allowFrom).toBeUndefined();
    expect(signal.transport).toEqual({ kind: "managed-native", cliPath: CLI, startupTimeoutMs: 45_000 });
  });

  it("leaves an external daemon or container transport as the owner set it", async () => {
    const transport = { kind: "external-native", url: "http://127.0.0.1:8080" };
    mockFs.readFile.mockResolvedValue(JSON.stringify({ channels: { signal: { transport } } }));
    await openclawConfig.setSignalAccount(NUMBER, CLI);
    expect(written().channels.signal.transport).toEqual(transport);
  });

  it("refuses an invalid number or a relative signal-cli path before writing", async () => {
    await expect(openclawConfig.setSignalAccount("5550000001", CLI)).rejects.toThrow(/invalid Signal/);
    await expect(openclawConfig.setSignalAccount(NUMBER, "signal-cli")).rejects.toThrow(/relative/);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("allows pairing approval on signal", async () => {
    await expect(openclawConfig.approveChannelPairing("signal", "bad")).rejects.toThrow(/Invalid pairing code/);
  });
});
