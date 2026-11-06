// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  audioExtensionFor,
  DEFAULT_REPLY_FORMAT,
  MIN_COMPRESSED_BYTES,
  MIN_WAV_BYTES,
  minAudioBytesFor,
  pickReplyFormat,
  playableReplyFormats,
  REPLY_FORMAT_MIME,
  sniffAudioMime,
} from "@/lib/voice-reply-format";

/**
 * Which format a spoken reply travels in, and how a clip is recognised.
 *
 * The rule: MP3 for everyone, because every browser decodes it; Ogg Opus only
 * for a browser that said it plays Opus; WAV only when nothing else can be
 * made. A reply the player cannot decode is a reply nobody hears, so the
 * default must be the universal one.
 */

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("pickReplyFormat", () => {
  it("answers Opus to a browser that listed it, whatever else it listed", () => {
    expect(pickReplyFormat(["opus", "mp3"])).toBe("opus");
    expect(pickReplyFormat(["mp3", "opus"])).toBe("opus");
    expect(pickReplyFormat([" OPUS "])).toBe("opus");
  });

  it("answers MP3 to a browser that did not list Opus", () => {
    expect(pickReplyFormat(["mp3"])).toBe("mp3");
  });

  it("answers MP3 when the request stated nothing usable — an older page, curl, garbage", () => {
    for (const stated of [undefined, null, "opus", 42, {}, [], [1, 2], ["flac"]]) {
      expect(pickReplyFormat(stated)).toBe("mp3");
    }
    expect(DEFAULT_REPLY_FORMAT).toBe("mp3");
  });

  it("answers WAV only to a list that names WAV and neither compressed format", () => {
    expect(pickReplyFormat(["wav"])).toBe("wav");
    expect(pickReplyFormat(["wav", "mp3"])).toBe("mp3");
  });
});

describe("playableReplyFormats", () => {
  it("offers Opus first on a confident 'probably', MP3 always", () => {
    const asked: string[] = [];
    const formats = playableReplyFormats((type) => { asked.push(type); return "probably"; });
    expect(formats).toEqual(["opus", "mp3"]);
    expect(asked[0]).toBe('audio/ogg; codecs="opus"');
  });

  it("does not offer Opus on a 'maybe' or a refusal — MP3 is the safe answer", () => {
    expect(playableReplyFormats(() => "maybe")).toEqual(["mp3"]);
    expect(playableReplyFormats(() => "")).toEqual(["mp3"]);
  });

  it("keeps MP3 when canPlayType throws", () => {
    expect(playableReplyFormats(() => { throw new Error("nope"); })).toEqual(["mp3"]);
  });

  it("asks the page's own audio element when no probe is given (jsdom answers nothing, so MP3)", () => {
    expect(playableReplyFormats()).toEqual(["mp3"]);
  });
});

describe("sniffAudioMime", () => {
  it("knows a WAV by RIFF…WAVE, not by RIFF alone", () => {
    expect(sniffAudioMime(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "))).toBe("audio/wav");
    expect(sniffAudioMime(bytes("RIFF", [0, 0, 0, 0], "AVI LIST"))).toBeNull();
  });

  it("knows the compressed formats a voice answers in", () => {
    expect(sniffAudioMime(bytes("OggS", [0, 2]))).toBe("audio/ogg");
    expect(sniffAudioMime(bytes("ID3", [4, 0]))).toBe("audio/mpeg");
    // A bare MPEG-2 layer III frame header, as an MP3 without a tag starts.
    expect(sniffAudioMime(bytes([0xff, 0xf3, 0x64, 0xc4]))).toBe("audio/mpeg");
    expect(sniffAudioMime(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe("audio/mpeg");
    // ADTS AAC shares the sync word; its layer bits are 00.
    expect(sniffAudioMime(bytes([0xff, 0xf1, 0x50, 0x80]))).toBe("audio/aac");
    expect(sniffAudioMime(bytes("fLaC"))).toBe("audio/flac");
    expect(sniffAudioMime(bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe("audio/mp4");
    expect(sniffAudioMime(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe("audio/webm");
  });

  it("answers null for bytes it does not know, and for too few of them", () => {
    expect(sniffAudioMime(new Uint8Array(4096))).toBeNull();
    expect(sniffAudioMime(new Uint8Array(0))).toBeNull();
    expect(sniffAudioMime(bytes("RIF"))).toBeNull();
    expect(sniffAudioMime(bytes([0xff]))).toBeNull();
  });
});

describe("minAudioBytesFor", () => {
  it("keeps the script's WAV floor for a WAV, and anything unlabelled", () => {
    expect(minAudioBytesFor("audio/wav")).toBe(MIN_WAV_BYTES);
    expect(minAudioBytesFor("audio/x-wav")).toBe(MIN_WAV_BYTES);
    expect(minAudioBytesFor(null)).toBe(MIN_WAV_BYTES);
    expect(MIN_WAV_BYTES).toBe(1024);
  });

  it("lets a short compressed answer through — a one-word reply in Opus is under a kilobyte", () => {
    expect(minAudioBytesFor("audio/mpeg")).toBe(MIN_COMPRESSED_BYTES);
    expect(minAudioBytesFor("audio/ogg; codecs=opus")).toBe(MIN_COMPRESSED_BYTES);
    expect(MIN_COMPRESSED_BYTES).toBeLessThan(MIN_WAV_BYTES);
    expect(MIN_COMPRESSED_BYTES).toBeGreaterThan(0);
  });
});

describe("content types and file names", () => {
  it("serves each reply format under its own type", () => {
    expect(REPLY_FORMAT_MIME).toEqual({ opus: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav" });
  });

  it("names a clip by its type, with an extension the media route serves", () => {
    expect(audioExtensionFor("audio/mpeg")).toBe(".mp3");
    expect(audioExtensionFor("audio/ogg")).toBe(".ogg");
    expect(audioExtensionFor("audio/opus")).toBe(".ogg");
    expect(audioExtensionFor("audio/webm")).toBe(".weba");
    expect(audioExtensionFor("audio/mp4")).toBe(".m4a");
    expect(audioExtensionFor("audio/aac")).toBe(".aac");
    expect(audioExtensionFor("audio/flac")).toBe(".flac");
    expect(audioExtensionFor("audio/wav")).toBe(".wav");
    expect(audioExtensionFor("application/octet-stream")).toBe(".wav");
  });
});
