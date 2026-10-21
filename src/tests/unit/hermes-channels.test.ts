import { describe, expect, it, vi, beforeEach } from "vitest";

// The Hermes leg of the guided channels: every call is argv into the Hermes
// CLI, so these tests pin the argv and how each answer is read.

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-telegram", () => ({ ensureHermesGateway: vi.fn(), hermesGatewayStatus: vi.fn() }));
vi.mock("@/lib/hermes-discord", () => ({ readHermesGatewaySnapshot: vi.fn() }));

import { runHermesCli } from "@/lib/hermes-cli";
import {
  approveHermesChannelPairing,
  hermesPlatformRegistered,
  parseHermesApproval,
  setHermesChannelSecrets,
} from "@/lib/hermes-channels";

const mockCli = vi.mocked(runHermesCli);

function cli(code: number, stdout = "") {
  return { code, stdout, stderr: "" } as Awaited<ReturnType<typeof runHermesCli>>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setHermesChannelSecrets", () => {
  it("runs `hermes config set` once per key", async () => {
    mockCli.mockResolvedValue(cli(0));
    await setHermesChannelSecrets({ SLACK_BOT_TOKEN: "bot-value", SLACK_APP_TOKEN: "app-value" });
    expect(mockCli.mock.calls.map((c) => c[0])).toEqual([
      ["config", "set", "SLACK_BOT_TOKEN", "bot-value"],
      ["config", "set", "SLACK_APP_TOKEN", "app-value"],
    ]);
  });

  it("names the key, never the value, when Hermes refuses it", async () => {
    mockCli.mockResolvedValue(cli(1));
    await expect(setHermesChannelSecrets({ SLACK_BOT_TOKEN: "bot-value" })).rejects.toThrow(
      "Hermes rejected SLACK_BOT_TOKEN",
    );
    await expect(setHermesChannelSecrets({ SLACK_BOT_TOKEN: "bot-value" })).rejects.not.toThrow(/bot-value/);
  });
});

describe("hermesPlatformRegistered", () => {
  it("reads `send --list <platform> --json`", async () => {
    mockCli.mockResolvedValue(cli(0, JSON.stringify({ platforms: { slack: [] } })));
    expect(await hermesPlatformRegistered("slack")).toBe(true);
    expect(mockCli.mock.calls[0][0]).toEqual(["send", "--list", "slack", "--json"]);
  });

  it("is false when Hermes answers without the platform, null when it cannot be asked", async () => {
    mockCli.mockResolvedValueOnce(cli(1, "no targets found for platform"));
    expect(await hermesPlatformRegistered("slack")).toBe(false);
    mockCli.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await hermesPlatformRegistered("slack")).toBeNull();
    mockCli.mockResolvedValueOnce(cli(0, "not json"));
    expect(await hermesPlatformRegistered("slack")).toBeNull();
  });

  it("refuses a platform outside the guided set before running anything", async () => {
    await expect(hermesPlatformRegistered("--help")).rejects.toThrow(/Unsupported/);
    expect(mockCli).not.toHaveBeenCalled();
  });
});

describe("approveHermesChannelPairing", () => {
  it("approves by code on the platform and reads who got in", async () => {
    mockCli.mockResolvedValue(cli(0, "  Approved! User Ada Lovelace (U01ABC2DEF3) on slack can now use the bot~\n"));
    expect(await approveHermesChannelPairing("slack", "abcd2345")).toEqual({
      userName: "Ada Lovelace",
      userId: "U01ABC2DEF3",
    });
    expect(mockCli.mock.calls[0][0]).toEqual(["pairing", "approve", "slack", "ABCD2345"]);
  });

  it("accepts Hermes' request id, lowercased", async () => {
    mockCli.mockResolvedValue(cli(0, "Approved! User U01 on slack can now use the bot"));
    await approveHermesChannelPairing("slack", "0123456789ABCDEF");
    expect(mockCli.mock.calls[0][0]).toEqual(["pairing", "approve", "slack", "0123456789abcdef"]);
  });

  it("treats exit 0 without the success line as not found, and reports a lockout", async () => {
    mockCli.mockResolvedValueOnce(cli(0, "No pending request matched."));
    await expect(approveHermesChannelPairing("slack", "ABCD2345")).rejects.toThrow(/not found/);
    mockCli.mockResolvedValueOnce(cli(0, "You are locked out for 1 hour."));
    await expect(approveHermesChannelPairing("slack", "ABCD2345")).rejects.toThrow(/locked/);
  });

  it("refuses a malformed code before running anything", async () => {
    await expect(approveHermesChannelPairing("slack", "--flag")).rejects.toThrow(/Invalid pairing code/);
    expect(mockCli).not.toHaveBeenCalled();
  });
});

describe("parseHermesApproval", () => {
  it("reads a name-less approval as the bare id", () => {
    expect(parseHermesApproval("Approved! User U0001 on slack can now use the bot")).toEqual({ userId: "U0001" });
    expect(parseHermesApproval("nothing")).toBeNull();
  });
});
