import { describe, expect, it, vi, beforeEach } from "vitest";

// Each edition hands the owner its own harness' manifest: Hermes generates one
// (`hermes slack manifest`), OpenClaw documents one. A Hermes box whose
// generator cannot run must never be handed OpenClaw's `/openclaw` command.

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));

import { runHermesCli } from "@/lib/hermes-cli";
import { OPENCLAW_SLACK_MANIFEST, readSlackManifest } from "@/lib/slack-manifest";

const mockCli = vi.mocked(runHermesCli);

beforeEach(() => vi.clearAllMocks());

describe("readSlackManifest", () => {
  it("serves OpenClaw's documented Socket Mode manifest without running anything", async () => {
    const result = await readSlackManifest("openclaw");
    expect(result.source).toBe("openclaw");
    const manifest = JSON.parse(result.manifest);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["app_mention", "message.im"]),
    );
    expect(manifest.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["chat:write", "im:history", "app_mentions:read"]),
    );
    expect(manifest.display_information.name).toBe("ClawBox");
    expect(mockCli).not.toHaveBeenCalled();
  });

  it("asks Hermes' own generator on the Hermes edition", async () => {
    const generated = { display_information: { name: "ClawBox" }, settings: { socket_mode_enabled: true }, features: {} };
    mockCli.mockResolvedValue({ code: 0, stdout: JSON.stringify(generated), stderr: "" } as never);
    const result = await readSlackManifest("hermes");
    expect(result.source).toBe("hermes");
    expect(JSON.parse(result.manifest)).toEqual(generated);
    expect(mockCli.mock.calls[0][0]).toEqual(["slack", "manifest", "--name", "ClawBox"]);
  });

  it.each([
    ["a failed run", { code: 1, stdout: "", stderr: "boom" }],
    ["output that is not JSON", { code: 0, stdout: "Usage: hermes slack", stderr: "" }],
    ["JSON that is not a manifest", { code: 0, stdout: "[1,2]", stderr: "" }],
  ])("falls back to a manifest without OpenClaw's command after %s", async (_label, res) => {
    mockCli.mockResolvedValue(res as never);
    const result = await readSlackManifest("hermes");
    expect(result.source).toBe("fallback");
    const manifest = JSON.parse(result.manifest);
    expect(manifest.features.slash_commands).toBeUndefined();
    expect(manifest.oauth_config.scopes.bot).not.toContain("commands");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    // The shared constant itself is never mutated by the fallback.
    expect(OPENCLAW_SLACK_MANIFEST.features.slash_commands).toHaveLength(1);
  });

  it("falls back when the CLI cannot be started", async () => {
    mockCli.mockRejectedValue(new Error("ENOENT"));
    expect((await readSlackManifest("hermes")).source).toBe("fallback");
  });
});
