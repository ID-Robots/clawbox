import { describe, it, expect, beforeEach, vi } from "vitest";

// The Settings half of the shared tools.media.models list. OpenClaw 2 keeps one
// list for every media capability, and the boot migration writes the ClawBox AI
// video row into it (gateway-pre-start-clawai-video.test.ts). Saving a speech
// preference must carry that row along untouched, and must not count it as a
// reason to write.

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  writes: [] as string[][][],
}));

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: async () => state.config,
  runOpenclawConfigSetBatch: async (batch: string[][]) => { state.writes.push(batch); },
}));

import { syncChannelAudio } from "@/lib/stt-channel";
import { CLAWBOX_AI_PROXY_URL } from "@/lib/harness/credentials";
import { buildAudioModels } from "@/lib/stt-preference";

const VIDEO_ROW = {
  type: "cli",
  command: "/usr/bin/python3",
  args: [
    "/opt/clawbox/scripts/openclaw/clawai-video-describe.py",
    "--max-chars",
    "{{MaxChars}}",
    "--prompt",
    "{{Prompt}}",
    "{{AttachmentPath}}",
  ],
  capabilities: ["video"],
};

function written(): unknown[] {
  const batch = state.writes.at(-1) ?? [];
  const row = batch.find(([key]) => key === "tools.media.models");
  return row ? (JSON.parse(row[1]) as unknown[]) : [];
}

beforeEach(() => {
  state.config = {};
  state.writes = [];
});

describe("syncChannelAudio beside the ClawBox AI video row", () => {
  it("does not write when only the video row sits beside the audio rows it would write", async () => {
    const cloud = buildAudioModels(["cloud"], false);
    state.config = { tools: { media: { audio: { baseUrl: CLAWBOX_AI_PROXY_URL }, models: [VIDEO_ROW, ...cloud] } } };

    expect(await syncChannelAudio(["cloud"], false)).toBe(false);
    expect(state.writes).toHaveLength(0);
  });

  it("carries the video row along when the speech order changes", async () => {
    const cloud = buildAudioModels(["cloud"], false);
    state.config = { tools: { media: { audio: { baseUrl: CLAWBOX_AI_PROXY_URL }, models: [...cloud, VIDEO_ROW] } } };

    expect(await syncChannelAudio(["local", "cloud"], true)).toBe(true);
    expect(written()).toEqual([VIDEO_ROW, ...buildAudioModels(["local", "cloud"], true)]);
  });
});
