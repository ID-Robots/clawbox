import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceConfigView, VoiceEngine } from "@/lib/voice-output";

/**
 * The format a spoken reply leaves the box in (src/lib/voice-speak.ts).
 *
 * The cloud is asked for the reply's own compressed format, so it does the
 * compressing; a WAV from any engine is compressed on the way out; the
 * Content-Type always names what the bytes ARE; and when compression cannot
 * happen the WAV goes out as it came. The audition is untouched: WAV, always.
 */

const compressSpeech = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tts-compress", () => ({ compressSpeech: (...a: unknown[]) => compressSpeech(...a) }));

import { inReplyFormat, speakInCloud, speakThroughChain, type Speaker } from "@/lib/voice-speak";

const WAV = new Uint8Array(Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(4096, 1)]));
const MP3 = new Uint8Array(Buffer.concat([Buffer.from("ID3\x04\0"), Buffer.alloc(3000, 2)]));
const OGG = new Uint8Array(Buffer.concat([Buffer.from("OggS\0\x02"), Buffer.alloc(2000, 2)]));

const cloudConfig = {
  tts: { provider: "openai", providers: { openai: { baseUrl: "https://clawbox.com/api/ai", model: "gpt-4o-mini-tts", apiKey: "claw_x" } } },
  models: { providers: { openai: { apiKey: "claw_x" } } },
} as unknown as VoiceConfigView;

let fetchMock: ReturnType<typeof vi.fn>;
/** The `response_format` of every speech request, in order. */
const askedFormats = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).response_format);

function answer(bytes: Uint8Array, type = "application/octet-stream", status = 200) {
  return new Response(new Uint8Array(bytes), { status, headers: { "Content-Type": type } });
}

beforeEach(() => {
  compressSpeech.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speakInCloud", () => {
  it("auditions in WAV — the one format no browser can decline", async () => {
    fetchMock.mockResolvedValue(answer(WAV, "audio/wav"));
    const res = await speakInCloud(cloudConfig, null, "hi");
    expect(res.status).toBe(200);
    expect(askedFormats()).toEqual(["wav"]);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("asks for a reply's own format and labels the bytes by what they are", async () => {
    // The proxy's own label is generic; the bytes are an MP3.
    fetchMock.mockResolvedValue(answer(MP3));
    const res = await speakInCloud(cloudConfig, null, "hi", "mp3");
    expect(askedFormats()).toEqual(["mp3"]);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
  });

  it("asks for Opus for a browser that plays it", async () => {
    fetchMock.mockResolvedValue(answer(OGG, "audio/opus"));
    const res = await speakInCloud(cloudConfig, null, "hi", "opus");
    expect(askedFormats()).toEqual(["opus"]);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  it("asks once more for MP3 when the proxy will not do Opus", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unsupported response_format" }), { status: 400 }))
      .mockResolvedValueOnce(answer(MP3, "audio/mpeg"));
    const res = await speakInCloud(cloudConfig, null, "hi", "opus");
    expect(res.status).toBe(200);
    expect(askedFormats()).toEqual(["opus", "mp3"]);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("does not retry a refusal that is about the credential or the rate, not the format", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const res = await speakInCloud(cloudConfig, null, "hi", "opus");
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("cloud_refused");
    expect(askedFormats()).toEqual(["opus"]);
  });

  it("labels a WAV as a WAV when the proxy ignored the format it was asked for", async () => {
    fetchMock.mockResolvedValue(answer(WAV, "audio/mpeg"));
    const res = await speakInCloud(cloudConfig, null, "hi", "mp3");
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("keeps a short compressed answer, and still refuses one with no audio in it", async () => {
    const shortMp3 = MP3.slice(0, 700);
    fetchMock.mockResolvedValueOnce(answer(shortMp3, "audio/mpeg"));
    expect((await speakInCloud(cloudConfig, null, "Yes.", "mp3")).status).toBe(200);
    fetchMock.mockResolvedValueOnce(answer(MP3.slice(0, 200), "audio/mpeg"));
    const empty = await speakInCloud(cloudConfig, null, "Yes.", "mp3");
    expect(empty.status).toBe(502);
    expect((await empty.json()).code).toBe("cloud_no_audio");
    // The WAV floor is the script's own, as before.
    fetchMock.mockResolvedValueOnce(answer(WAV.slice(0, 900), "audio/wav"));
    expect((await speakInCloud(cloudConfig, null, "Yes.")).status).toBe(502);
  });
});

describe("inReplyFormat", () => {
  const wavReply = () => new Response(new Uint8Array(WAV), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-ClawBox-Voice-Engine": "local" },
  });

  it("compresses a WAV into the reply's format, and says so in the Content-Type", async () => {
    compressSpeech.mockResolvedValue(MP3);
    const res = await inReplyFormat(wavReply(), "mp3");
    expect(compressSpeech).toHaveBeenCalledWith(expect.any(Uint8Array), "mp3");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
    // Everything else about the answer rides along.
    expect(res.headers.get("X-ClawBox-Voice-Engine")).toBe("local");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves Opus as audio/ogg", async () => {
    compressSpeech.mockResolvedValue(OGG);
    const res = await inReplyFormat(wavReply(), "opus");
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  it("sends the WAV as it came when the box cannot compress (no ffmpeg) — never fails the reply", async () => {
    compressSpeech.mockResolvedValue(null);
    const res = await inReplyFormat(wavReply(), "mp3");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WAV);
  });

  it("leaves an already compressed answer alone, correcting only a wrong label", async () => {
    const res = await inReplyFormat(new Response(new Uint8Array(OGG), { headers: { "Content-Type": "audio/wav" } }), "mp3");
    expect(compressSpeech).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  it("does not hand ffmpeg bytes that only CLAIM to be a WAV", async () => {
    const res = await inReplyFormat(new Response(new Uint8Array(4096), { headers: { "Content-Type": "audio/wav" } }), "mp3");
    expect(compressSpeech).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("keeps WAV when WAV was asked for", async () => {
    const res = await inReplyFormat(wavReply(), "wav");
    expect(compressSpeech).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("passes a refusal straight through", async () => {
    const refusal = new Response(JSON.stringify({ code: "local_failed" }), { status: 502 });
    const res = await inReplyFormat(refusal, "mp3");
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("local_failed");
  });
});

describe("speakThroughChain", () => {
  it("hands every engine the reply's format, and keeps WAV for a caller that names none", async () => {
    const engine = (id: "local" | "cloud"): VoiceEngine => ({ id, providerId: id, label: id, configured: true, detail: "" });
    const local = vi.fn<Speaker>(async () => new Response(JSON.stringify({ code: "local_failed" }), { status: 502 }));
    const cloud = vi.fn<Speaker>(async () => answer(MP3, "audio/mpeg"));
    await speakThroughChain({} as VoiceConfigView, [engine("local"), engine("cloud")], "local", "hi", { local, cloud }, "opus");
    expect(local.mock.calls[0][3]).toBe("opus");
    expect(cloud.mock.calls[0][3]).toBe("opus");
    await speakThroughChain({} as VoiceConfigView, [engine("cloud")], "cloud", "hi", { local, cloud });
    expect(cloud.mock.calls[1][3]).toBe("wav");
  });
});
