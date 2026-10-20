import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
}));

import { get } from "@/lib/config-store";
import {
  CLAWAI_MEDIA_FLAGS_KEY,
  clawaiMusicArmable,
  clawaiMusicWithdrawable,
  parseClawaiMediaFlags,
  readClawaiMediaFlags,
} from "@/lib/clawai-media-flags";
import {
  CLAWBOX_AI_MUSIC_MODEL,
  clawboxAiMediaBaseUrl,
  isClawboxAiMusicModelRef,
} from "@/lib/clawbox-ai-models";

const mockGet = vi.mocked(get);

describe("parseClawaiMediaFlags", () => {
  it("reads an array of words", () => {
    expect([...parseClawaiMediaFlags(["music", "video_frames"])].sort()).toEqual(["music", "video_frames"]);
  });

  it("reads a hand-edited comma list, forgiving case and whitespace", () => {
    expect([...parseClawaiMediaFlags(" Music ,VIDEO_FRAMES")].sort()).toEqual(["music", "video_frames"]);
  });

  it("ignores words it does not know and values that are not words", () => {
    expect([...parseClawaiMediaFlags(["video_gen", 3, null, "music"])]).toEqual(["music"]);
  });

  it.each([undefined, null, 42, {}, { music: true }, ""])("switches nothing on for %j", (value) => {
    expect(parseClawaiMediaFlags(value).size).toBe(0);
  });
});

describe("readClawaiMediaFlags", () => {
  // A block, not an expression: vitest runs a function returned from a hook as
  // its teardown, and `mockReset()` returns the mock itself.
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("reads the store key", async () => {
    mockGet.mockResolvedValue(["music"]);

    expect([...(await readClawaiMediaFlags())]).toEqual(["music"]);
    expect(mockGet).toHaveBeenCalledWith(CLAWAI_MEDIA_FLAGS_KEY);
  });

  it("fails closed when the store cannot be read", async () => {
    mockGet.mockImplementation(async () => {
      throw new Error("EACCES");
    });

    expect((await readClawaiMediaFlags()).size).toBe(0);
  });
});

describe("the music gate", () => {
  const on = parseClawaiMediaFlags(["music"]);
  const off = parseClawaiMediaFlags([]);

  it("arms only Max with the flag on", () => {
    expect(clawaiMusicArmable(on, "pro")).toBe(true);
    expect(clawaiMusicArmable(on, "flash")).toBe(false);
    expect(clawaiMusicArmable(on, "free")).toBe(false);
    expect(clawaiMusicArmable(on, null)).toBe(false);
    expect(clawaiMusicArmable(off, "pro")).toBe(false);
  });

  it("withdraws on the flag going off, whatever the plan", () => {
    expect(clawaiMusicWithdrawable(off, "pro")).toBe(true);
    expect(clawaiMusicWithdrawable(off, undefined)).toBe(true);
  });

  it("withdraws on a RECORDED plan below Max, and never on not knowing", () => {
    expect(clawaiMusicWithdrawable(on, "flash")).toBe(true);
    expect(clawaiMusicWithdrawable(on, "free")).toBe(true);
    expect(clawaiMusicWithdrawable(on, "pro")).toBe(false);
    expect(clawaiMusicWithdrawable(on, undefined)).toBe(false);
    expect(clawaiMusicWithdrawable(on, "platinum")).toBe(false);
  });
});

describe("music model helpers", () => {
  it("builds the media route under any proxy URL spelling", () => {
    expect(clawboxAiMediaBaseUrl("https://clawbox.com/api/ai")).toBe("https://clawbox.com/api/ai/media");
    expect(clawboxAiMediaBaseUrl(" https://clawbox.com/api/ai// ")).toBe("https://clawbox.com/api/ai/media");
  });

  it("recognises our music ref in any casing and nothing else", () => {
    expect(isClawboxAiMusicModelRef(CLAWBOX_AI_MUSIC_MODEL)).toBe(true);
    expect(isClawboxAiMusicModelRef(` ${CLAWBOX_AI_MUSIC_MODEL.toUpperCase()} `)).toBe(true);
    expect(isClawboxAiMusicModelRef("google/lyria-3-pro-preview")).toBe(false);
    expect(isClawboxAiMusicModelRef(undefined)).toBe(false);
  });
});
