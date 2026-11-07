import { describe, expect, it } from "vitest";
import { advanceChatStream, createChatStreamCursor, mergeChatStreamMessage } from "@/lib/chat-stream-message";
import { extractText } from "@/lib/harness/openclaw-gateway-adapter";

/**
 * TASK-2228: the gateway's delta frames for one run, as a socket gets them
 * (OpenClaw 2026.10.9, protocol 4, read off a board): the first carries the
 * whole text so far, the rest only what was added.
 */
const RUN = "d12521d9-6a1e-46c1-ad1a-1296a4f81868";
const FRAMES = [
  { runId: RUN, state: "delta", deltaText: "**", message: { role: "assistant", content: [{ type: "text", text: "**" }], timestamp: 1 } },
  { runId: RUN, state: "delta", deltaText: "Три изречения за морето**\n\n1. Мо" },
  { runId: RUN, state: "delta", deltaText: "рето не помни кой" },
];

describe("mergeChatStreamMessage", () => {
  it("takes a snapshot as it is", () => {
    expect(mergeChatStreamMessage(undefined, FRAMES[0])).toBe(FRAMES[0].message);
  });

  it("appends an append-only frame to the last text block", () => {
    const merged = mergeChatStreamMessage(FRAMES[0].message, FRAMES[1]);
    expect(extractText(merged)).toBe("**Три изречения за морето**\n\n1. Мо");
    // The baseline it was merged onto is left as it was.
    expect(extractText(FRAMES[0].message)).toBe("**");
  });

  it("keeps the blocks that are not text, after a replaced text", () => {
    const previous = { role: "assistant", content: [{ type: "text", text: "old" }, { type: "canvas", id: "c1" }] };
    expect(mergeChatStreamMessage(previous, { deltaText: "new", replace: true })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "new" }, { type: "canvas", id: "c1" }],
    });
  });

  it("appends to string content and starts a text block where there is none", () => {
    expect(mergeChatStreamMessage({ role: "assistant", content: "Hel" }, { deltaText: "lo" })).toEqual({ role: "assistant", content: "Hello" });
    expect(mergeChatStreamMessage({ role: "assistant", content: [] }, { deltaText: "Hi" })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
    });
  });

  it("has nothing to append to without a baseline, unless the frame replaces", () => {
    expect(mergeChatStreamMessage(undefined, { deltaText: "lost" })).toBeUndefined();
    expect(mergeChatStreamMessage(undefined, { deltaText: "whole", replace: true })).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "whole" }],
    });
  });

  it("keeps the previous message for a frame that adds nothing", () => {
    const previous = FRAMES[0].message;
    expect(mergeChatStreamMessage(previous, { deltaText: "" })).toBe(previous);
    expect(mergeChatStreamMessage(previous, {})).toBe(previous);
  });
});

describe("advanceChatStream", () => {
  it("adds a run's frames up to its answer so far", () => {
    const cursor = createChatStreamCursor();
    const seen = FRAMES.map((frame) => extractText(advanceChatStream(cursor, frame)));
    expect(seen).toEqual(["**", "**Три изречения за морето**\n\n1. Мо", "**Три изречения за морето**\n\n1. Морето не помни кой"]);
  });

  it("does not carry one run's text into another's append-only frames", () => {
    const cursor = createChatStreamCursor();
    for (const frame of FRAMES) advanceChatStream(cursor, frame);
    expect(advanceChatStream(cursor, { runId: "another-run", state: "delta", deltaText: " tail" })).toBeUndefined();
    const next = advanceChatStream(cursor, {
      runId: "another-run",
      state: "delta",
      deltaText: "Hi",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    expect(extractText(next)).toBe("Hi");
    expect(extractText(advanceChatStream(cursor, { runId: "another-run", state: "delta", deltaText: " there" }))).toBe("Hi there");
  });

  it("keeps each run's own text when two runs' frames interleave", () => {
    const cursor = createChatStreamCursor();
    advanceChatStream(cursor, FRAMES[0]);
    advanceChatStream(cursor, { runId: "other", state: "delta", deltaText: "A", message: { role: "assistant", content: [{ type: "text", text: "A" }] } });
    expect(extractText(advanceChatStream(cursor, FRAMES[1]))).toBe("**Три изречения за морето**\n\n1. Мо");
    expect(extractText(advanceChatStream(cursor, { runId: "other", state: "delta", deltaText: "B" }))).toBe("AB");
  });

  it("forgets the oldest runs, not the newest", () => {
    const cursor = createChatStreamCursor();
    const start = (runId: string) => advanceChatStream(cursor, { runId, state: "delta", deltaText: runId, message: { role: "assistant", content: [{ type: "text", text: runId }] } });
    for (let i = 0; i < 12; i += 1) start(`run-${i}`);
    expect(cursor.runs.size).toBe(8);
    expect(advanceChatStream(cursor, { runId: "run-0", state: "delta", deltaText: "!" })).toBeUndefined();
    expect(extractText(advanceChatStream(cursor, { runId: "run-11", state: "delta", deltaText: "!" }))).toBe("run-11!");
  });

  it("reads a snapshot on every frame the old way", () => {
    const cursor = createChatStreamCursor();
    const snapshot = (text: string) => ({ runId: RUN, state: "delta", message: { role: "assistant", content: [{ type: "text", text }] } });
    expect(extractText(advanceChatStream(cursor, snapshot("Hel")))).toBe("Hel");
    expect(extractText(advanceChatStream(cursor, snapshot("Hello")))).toBe("Hello");
  });
});
