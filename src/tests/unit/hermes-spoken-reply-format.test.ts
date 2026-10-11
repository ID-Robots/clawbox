import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The clip a Hermes reply is stored with (src/lib/harness/hermes-spoken-reply.ts).
 *
 * It is STORED and played back later from whatever browser opens the chat,
 * so it is MP3 — the one compressed format every browser decodes — whenever
 * the voice answered WAV and the box can compress it; a WAV that cannot be
 * compressed is stored as a WAV; anything already compressed is kept as
 * Hermes made it. The file is named by what its bytes are, so the media route
 * serves it under the right Content-Type.
 */

const speakWithHermes = vi.hoisted(() => vi.fn());
const compressSpeech = vi.hoisted(() => vi.fn());
const dirs = vi.hoisted(() => ({ spoken: "" }));

vi.mock("@/lib/hermes-tts", () => ({ speakWithHermes: (...a: unknown[]) => speakWithHermes(...a) }));
vi.mock("@/lib/tts-compress", () => ({ compressSpeech: (...a: unknown[]) => compressSpeech(...a) }));
vi.mock("@/lib/harness/media-root", () => ({
  chatSpokenReplyDir: async () => dirs.spoken,
  pruneMediaDir: async () => {},
  resolveInMediaRoot: async (p: string) => p,
  SPOKEN_REPLY_RETENTION: {},
}));

import { speakHermesReply } from "@/lib/harness/hermes-spoken-reply";

const WAV = new Uint8Array(Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(8192, 1)]));
const MP3 = new Uint8Array(Buffer.concat([Buffer.from("ID3\x04\0"), Buffer.alloc(1000, 2)]));
const OGG = new Uint8Array(Buffer.concat([Buffer.from("OggS\0\x02"), Buffer.alloc(1000, 2)]));

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-spoken-format-"));
  dirs.spoken = path.join(root, "chat-spoken");
  speakWithHermes.mockReset();
  compressSpeech.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("speakHermesReply's stored clip", () => {
  it("stores Kokoro's WAV as an MP3, under a .mp3 name", async () => {
    speakWithHermes.mockResolvedValue({ ok: true, audio: WAV, mime: "audio/wav" });
    compressSpeech.mockResolvedValue(MP3);
    const clip = await speakHermesReply("The lantern is green.");

    expect(compressSpeech).toHaveBeenCalledWith(expect.any(Uint8Array), "mp3", expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(clip).toMatch(/\.mp3$/);
    expect(new Uint8Array(fs.readFileSync(clip!))).toEqual(MP3);
  });

  it("stores the WAV as a WAV when the box cannot compress it — the reply keeps its voice", async () => {
    speakWithHermes.mockResolvedValue({ ok: true, audio: WAV, mime: "audio/wav" });
    compressSpeech.mockResolvedValue(null);
    const clip = await speakHermesReply("The lantern is green.");

    expect(clip).toMatch(/\.wav$/);
    expect(fs.statSync(clip!).size).toBe(WAV.byteLength);
  });

  it("keeps an already compressed clip as Hermes made it, named by its bytes not its label", async () => {
    speakWithHermes.mockResolvedValue({ ok: true, audio: OGG, mime: "audio/wav" });
    const clip = await speakHermesReply("The lantern is green.");

    expect(compressSpeech).not.toHaveBeenCalled();
    expect(clip).toMatch(/\.ogg$/);
  });

  it("keeps a clip whose bytes it does not recognise under the label Hermes gave", async () => {
    speakWithHermes.mockResolvedValue({ ok: true, audio: new Uint8Array(4096), mime: "audio/mpeg" });
    const clip = await speakHermesReply("The lantern is green.");

    expect(compressSpeech).not.toHaveBeenCalled();
    expect(clip).toMatch(/\.mp3$/);
  });
});
