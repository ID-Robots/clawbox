import { describe, expect, it } from "vitest";
import { CLOUD_VOICES, cloudVoicesFor, isCloudVoice, isCloudVoiceFor, isLegacyCloudModel } from "@/lib/voice-catalog";
import { cloudModelFrom, cloudVoiceFrom } from "@/lib/voice-output";

/**
 * The cloud voice list is per MODEL. OpenAI's `tts-1` and `tts-1-hd` refuse
 * `ballad` and `verse` (they are `gpt-4o-mini-tts` voices) with a 400 at
 * speech time, so a catalogue that offered all eleven to every model was two
 * dropdown entries that played an error. This is the contract the Voice tab,
 * the voice action and the sample route all read from.
 */

const NEWER_ONLY = ["ballad", "verse"];
const LEGACY_SAFE = CLOUD_VOICES.map((v) => v.id).filter((id) => !NEWER_ONLY.includes(id));

function config(entry: Record<string, unknown>) {
  return {
    messages: { tts: { provider: "openai", providers: { openai: { apiKey: "claw_x", baseUrl: "https://clawbox.com/api/ai", ...entry } } } },
    models: { providers: { openai: { apiKey: "claw_x" } } },
  };
}

describe("cloudVoicesFor", () => {
  it("drops ballad and verse for tts-1 and tts-1-hd, and keeps the other nine", () => {
    for (const model of ["tts-1", "tts-1-hd"]) {
      expect(cloudVoicesFor(model).map((v) => v.id)).toEqual(LEGACY_SAFE);
    }
  });

  it("offers the full list to gpt-4o-mini-tts, to a model it has never heard of, and when none is configured", () => {
    // Refusing a voice a model may well have is the worse mistake.
    for (const model of ["gpt-4o-mini-tts", "some-future-model", null, undefined, ""]) {
      expect(cloudVoicesFor(model)).toEqual(CLOUD_VOICES);
    }
  });

  it("reads the model id leniently — case and whitespace are not a different model", () => {
    expect(isLegacyCloudModel(" TTS-1 ")).toBe(true);
    expect(isLegacyCloudModel("tts-1-hd")).toBe(true);
    expect(isLegacyCloudModel("tts-1-hd-x")).toBe(false);
  });
});

describe("isCloudVoiceFor", () => {
  it("answers for this model, where isCloudVoice answers for any", () => {
    expect(isCloudVoice("verse")).toBe(true);
    expect(isCloudVoiceFor("tts-1", "verse")).toBe(false);
    expect(isCloudVoiceFor("tts-1", "nova")).toBe(true);
    expect(isCloudVoiceFor("gpt-4o-mini-tts", "verse")).toBe(true);
    expect(isCloudVoiceFor(null, "verse")).toBe(true);
    expect(isCloudVoiceFor("tts-1", "hal9000")).toBe(false);
    expect(isCloudVoiceFor("tts-1", 42)).toBe(false);
  });
});

describe("what the status reports", () => {
  it("names the configured cloud model, or null for the provider's default", () => {
    expect(cloudModelFrom(config({ model: "tts-1-hd" }))).toBe("tts-1-hd");
    expect(cloudModelFrom(config({ model: "  " }))).toBeNull();
    expect(cloudModelFrom(config({}))).toBeNull();
  });

  it("does not report a saved voice the configured model refuses as the current one", () => {
    // A `verse` left in the file beside `tts-1` is a voice that model will
    // not speak; the engine's default is what the box actually says.
    expect(cloudVoiceFrom(config({ model: "tts-1", voice: "verse" }))).toBe("alloy");
    expect(cloudVoiceFrom(config({ model: "gpt-4o-mini-tts", voice: "verse" }))).toBe("verse");
    expect(cloudVoiceFrom(config({ voice: "verse" }))).toBe("verse");
  });
});
