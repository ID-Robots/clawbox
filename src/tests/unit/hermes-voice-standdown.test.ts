import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readHermesVoiceStanddown, clearHermesVoiceStanddown, rememberHermesVoiceStanddown, rememberHermesVoiceLock } from "@/lib/hermes-voice-standdown";

describe("voice restoration history", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-voice-history-"));
    vi.stubEnv("HERMES_HOME", home);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
  it("keeps a manual local choice after its restoration marker is cleared", async () => {
    const stamp = path.join(home, "config.yaml.clawbox-voice-standdown.json");
    await fs.writeFile(stamp, JSON.stringify({ version: 1, provider: "clawbox-local", cloudVoice: "shimmer" }));
    expect(await readHermesVoiceStanddown()).toEqual({ cloudVoice: "shimmer" });
    await clearHermesVoiceStanddown();
    expect(await readHermesVoiceStanddown()).toBeNull();
    await clearHermesVoiceStanddown();
  });
  it("lets two spoken replies remember at once, each through its own temp file (TASK-2501)", async () => {
    await Promise.all([
      rememberHermesVoiceStanddown("shimmer"),
      rememberHermesVoiceStanddown("nova"),
      rememberHermesVoiceLock("elevenlabs"),
      rememberHermesVoiceLock("elevenlabs"),
    ]);
    expect((await readHermesVoiceStanddown())?.cloudVoice).toMatch(/^(shimmer|nova)$/);
    expect(JSON.parse(await fs.readFile(path.join(home, "config.yaml.clawbox-voice-lock.json"), "utf8"))).toEqual({ version: 1, provider: "elevenlabs" });
    // No temp file is left behind.
    expect((await fs.readdir(home)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("removes its own temp file when the rename fails", async () => {
    // A directory where the marker goes: the rename cannot replace it.
    await fs.mkdir(path.join(home, "config.yaml.clawbox-voice-lock.json"));
    await expect(rememberHermesVoiceLock("elevenlabs")).rejects.toThrow();
    expect((await fs.readdir(home)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("invalid history never grants permission to move off the local voice", async () => {
    await fs.writeFile(path.join(home, "config.yaml.clawbox-voice-standdown.json"), "not json");
    expect(await readHermesVoiceStanddown()).toBeNull();
  });
});
