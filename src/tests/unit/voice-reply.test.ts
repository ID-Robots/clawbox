import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The spoken-replies switch (src/lib/voice-reply.ts): on by default, and the
 * boot repair that seeds the gateway's `tts.auto` for a box that predates the
 * switch — written only when the key is absent, into whichever home holds the
 * providers, so a hand-set "always" or "tagged" is never overwritten.
 */

const getMock = vi.fn();
const setMock = vi.fn();
const readConfigMock = vi.fn();
const writeConfigMock = vi.fn();

vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => getMock(...a),
  set: (...a: unknown[]) => setMock(...a),
}));
let absent = false;
vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: () => absent,
  readConfigForWrite: (...a: unknown[]) => readConfigMock(...a),
  writeConfig: (...a: unknown[]) => writeConfigMock(...a),
}));

async function lib() {
  return await import("@/lib/voice-reply");
}

beforeEach(() => {
  vi.resetModules();
  absent = false;
  getMock.mockReset().mockResolvedValue(undefined);
  setMock.mockReset().mockResolvedValue(undefined);
  readConfigMock.mockReset();
  writeConfigMock.mockReset().mockResolvedValue(undefined);
});

describe("the switch", () => {
  it("is on until the owner turns it off", async () => {
    const { getVoiceAutoReply, ttsAutoModeFor } = await lib();
    expect(await getVoiceAutoReply()).toBe(true);
    getMock.mockResolvedValue(false);
    expect(await getVoiceAutoReply()).toBe(false);
    expect(ttsAutoModeFor(true)).toBe("inbound");
    expect(ttsAutoModeFor(false)).toBe("off");
  });
});

describe("ensureVoiceAutoReplyMode", () => {
  it("seeds inbound into the v2 home when the mode is absent", async () => {
    readConfigMock.mockResolvedValue({ tts: { provider: "openai", providers: { openai: {} } } });
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(true);
    expect(writeConfigMock.mock.calls[0][0].tts).toEqual({ provider: "openai", providers: { openai: {} }, auto: "inbound" });
  });

  it("seeds off when the owner's switch is off", async () => {
    getMock.mockResolvedValue(false);
    readConfigMock.mockResolvedValue({ tts: { providers: {} } });
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(true);
    expect(writeConfigMock.mock.calls[0][0].tts.auto).toBe("off");
  });

  it("writes into the legacy home while the providers still live there", async () => {
    readConfigMock.mockResolvedValue({ messages: { tts: { provider: "x", providers: { x: {} } } } });
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(true);
    const written = writeConfigMock.mock.calls[0][0];
    expect(written.messages.tts.auto).toBe("inbound");
    expect(written.tts).toBeUndefined();
  });

  it("never overwrites a mode that is already there", async () => {
    readConfigMock.mockResolvedValue({ tts: { providers: {}, auto: "always" } });
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(false);
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it("creates the v2 block on a box with no speech config at all", async () => {
    readConfigMock.mockResolvedValue({ agents: { defaults: {} } });
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(true);
    const written = writeConfigMock.mock.calls[0][0];
    expect(written.tts).toEqual({ auto: "inbound" });
    expect(written.agents).toEqual({ defaults: {} });
  });

  it("never writes a config it could not read, or one that is not there yet", async () => {
    // readConfig answers {} to every failure; writing that back would leave
    // openclaw.json holding one key. The writer's reader throws instead.
    readConfigMock.mockRejectedValue(new Error("openclaw.json could not be read"));
    const { ensureVoiceAutoReplyMode } = await lib();
    await expect(ensureVoiceAutoReplyMode()).rejects.toThrow();
    expect(writeConfigMock).not.toHaveBeenCalled();
    // ENOENT reads as {}: nothing to seed into — onboarding creates the file.
    readConfigMock.mockResolvedValue({});
    expect(await ensureVoiceAutoReplyMode()).toBe(false);
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it("does nothing on the Hermes edition", async () => {
    absent = true;
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(false);
    expect(readConfigMock).not.toHaveBeenCalled();
  });
});
