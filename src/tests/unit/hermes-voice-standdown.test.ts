import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readHermesVoiceStanddown, clearHermesVoiceStanddown } from "@/lib/hermes-voice-standdown";

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
  it("invalid history never grants permission to move off the local voice", async () => {
    await fs.writeFile(path.join(home, "config.yaml.clawbox-voice-standdown.json"), "not json");
    expect(await readHermesVoiceStanddown()).toBeNull();
  });
});
