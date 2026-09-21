import { describe, expect, it, vi, beforeEach } from "vitest";

// The Hermes leg of the Discord integration is one CLI call and one probe, so
// what is worth pinning is the exact argv (the key name is what decides whether
// the value lands in ~/.hermes/.env or, wrongly, in config.yaml) and the
// tri-state probe.

const runHermesCliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));

import { hermesDiscordRegistered, setHermesDiscordToken } from "@/lib/hermes-discord";

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

describe("setHermesDiscordToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes DISCORD_BOT_TOKEN through `hermes config set`", async () => {
    runHermesCliMock.mockResolvedValue(ok());

    await setHermesDiscordToken(TOKEN);

    // DISCORD_BOT_TOKEN is in the Hermes CLI's own env-key allowlist
    // (hermes_cli/config.py), which is what routes it to ~/.hermes/.env rather
    // than into config.yaml as a plaintext scalar. Changing this key name or
    // adding a dot to it silently changes the destination file.
    expect(runHermesCliMock).toHaveBeenCalledTimes(1);
    const [argv] = runHermesCliMock.mock.calls[0];
    expect(argv).toEqual(["config", "set", "DISCORD_BOT_TOKEN", TOKEN]);
  });

  it("passes the token as its own argv element, never a shell string", async () => {
    runHermesCliMock.mockResolvedValue(ok());
    await setHermesDiscordToken(TOKEN);
    const [argv] = runHermesCliMock.mock.calls[0];
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[3]).toBe(TOKEN);
  });

  it("forwards the caller's abort signal", async () => {
    runHermesCliMock.mockResolvedValue(ok());
    const controller = new AbortController();
    await setHermesDiscordToken(TOKEN, controller.signal);
    expect(runHermesCliMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });

  it("fails without echoing the CLI output, which can quote the token", async () => {
    runHermesCliMock.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: `invalid value for DISCORD_BOT_TOKEN: ${TOKEN}`,
    });

    const err = await setHermesDiscordToken(TOKEN).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Hermes rejected the bot token");
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("hermesDiscordRegistered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is true when Hermes lists discord among its platforms", async () => {
    runHermesCliMock.mockResolvedValue(ok(JSON.stringify({ platforms: { discord: {} } })));
    await expect(hermesDiscordRegistered()).resolves.toBe(true);
    expect(runHermesCliMock.mock.calls[0][0]).toEqual(["send", "--list", "discord", "--json"]);
  });

  it("is false when Hermes answers with other platforms only", async () => {
    runHermesCliMock.mockResolvedValue(ok(JSON.stringify({ platforms: { telegram: {} } })));
    await expect(hermesDiscordRegistered()).resolves.toBe(false);
  });

  it("is false when the CLI exits non-zero (a real 'no targets' answer)", async () => {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "no targets found" });
    await expect(hermesDiscordRegistered()).resolves.toBe(false);
  });

  it("is null — not false — when Hermes could not be asked", async () => {
    runHermesCliMock.mockRejectedValue(new Error("hermes timed out"));
    await expect(hermesDiscordRegistered()).resolves.toBeNull();
  });

  it("is null when the output cannot be parsed", async () => {
    runHermesCliMock.mockResolvedValue(ok("Listing targets…"));
    await expect(hermesDiscordRegistered()).resolves.toBeNull();
  });
});
