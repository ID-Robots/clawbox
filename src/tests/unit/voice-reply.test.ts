import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The spoken-replies switch (src/lib/voice-reply.ts): OFF by default — only a
 * stored `true` speaks (the owner's ruling, 2026-09-15) — and the boot repair
 * that seeds the gateway's `tts.auto` for a box that predates the switch —
 * written only when the key is absent, into whichever home holds the
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
  it("is off until the owner turns it on", async () => {
    const { getVoiceAutoReply, ttsAutoModeFor } = await lib();
    // A fresh box: nothing stored.
    expect(await getVoiceAutoReply()).toBe(false);
    getMock.mockResolvedValue(true);
    expect(await getVoiceAutoReply()).toBe(true);
    getMock.mockResolvedValue(false);
    expect(await getVoiceAutoReply()).toBe(false);
    expect(ttsAutoModeFor(true)).toBe("inbound");
    expect(ttsAutoModeFor(false)).toBe("off");
  });

  it("reads anything but a stored `true` as off", async () => {
    // A hand edit or an older writer: "on" as a string, 1, null. None of them
    // is the owner's own switch write, and a box speaking on a guess is the
    // worse mistake.
    const { getVoiceAutoReply } = await lib();
    for (const stored of ["true", "on", 1, null, {}]) {
      getMock.mockResolvedValue(stored);
      expect(await getVoiceAutoReply()).toBe(false);
    }
  });
});

describe("ensureVoiceAutoReplyMode", () => {
  it("seeds off into the v2 home on a fresh box — no stored switch, no mode", async () => {
    // The default is off, so a box that has never been asked is seeded the
    // mode that speaks nothing on a channel.
    readConfigMock.mockResolvedValue({ tts: { provider: "openai", providers: { openai: {} } } });
    const { ensureVoiceAutoReplyMode } = await lib();
    expect(await ensureVoiceAutoReplyMode()).toBe(true);
    expect(writeConfigMock.mock.calls[0][0].tts).toEqual({ provider: "openai", providers: { openai: {} }, auto: "off" });
  });

  it("seeds inbound when the owner's switch is on", async () => {
    getMock.mockResolvedValue(true);
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
    getMock.mockResolvedValue(true);
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
    expect(written.tts).toEqual({ auto: "off" });
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
