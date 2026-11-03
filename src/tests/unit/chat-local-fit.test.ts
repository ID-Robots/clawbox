import { describe, expect, it } from "vitest";
import {
  LOCAL_COMPACTION_DEADLINE_MS,
  LOCAL_FIT_REPLY_RESERVE_TOKENS,
  compactionFramePhase,
  localFitLimit,
  localTurnPhase,
  openclawSessionTokens,
  shortTokenCount,
  tooLongForLocal,
} from "@/lib/chat-local-fit";

/**
 * TASK-2127: the rules behind a long conversation on Local AI — when the chat
 * offers a new chat instead of sending, and what a local turn's status line
 * may say.
 */
describe("openclawSessionTokens", () => {
  it("takes the larger of the measured last prompt and the core's pre-prompt estimate", () => {
    // The row a board answered `sessions.describe` with (trimmed).
    expect(openclawSessionTokens({
      totalTokens: 13721,
      contextTokens: 131072,
      contextBudgetStatus: { estimatedPromptTokens: 18076, route: "fits" },
    })).toBe(18076);
    expect(openclawSessionTokens({ totalTokens: 100460 })).toBe(100460);
    expect(openclawSessionTokens({ contextBudgetStatus: { estimatedPromptTokens: 100460 } })).toBe(100460);
  });

  it("says nothing for a row with no numbers, or numbers that are not counts", () => {
    expect(openclawSessionTokens(null)).toBeNull();
    expect(openclawSessionTokens({})).toBeNull();
    expect(openclawSessionTokens({ totalTokens: 0, contextBudgetStatus: { estimatedPromptTokens: -1 } })).toBeNull();
    expect(openclawSessionTokens({ totalTokens: "100000" })).toBeNull();
    expect(openclawSessionTokens({ totalTokens: Number.NaN })).toBeNull();
  });
});

describe("tooLongForLocal", () => {
  it("compares against the window minus the local reply's reserve", () => {
    expect(LOCAL_FIT_REPLY_RESERVE_TOKENS).toBe(8192);
    expect(localFitLimit(32768)).toBe(24576);
    // The bug's conversation, on OpenClaw's 32k llama.cpp window.
    expect(tooLongForLocal({ tokens: 100460 }, 32768)).toBe(true);
    expect(tooLongForLocal({ tokens: 24577 }, 32768)).toBe(true);
    expect(tooLongForLocal({ tokens: 24576 }, 32768)).toBe(false);
    // A fresh cloud chat carries OpenClaw's full prompt (~13–18k): not "too long".
    expect(tooLongForLocal({ tokens: 18076 }, 32768)).toBe(false);
  });

  it("never lets a small window call every chat too long", () => {
    expect(localFitLimit(8192)).toBe(4096);
    expect(tooLongForLocal({ tokens: 3000 }, 8192)).toBe(false);
  });

  it("uses the harness's own limit when it gives one, and its window over the caller's", () => {
    expect(tooLongForLocal({ tokens: 40000, limit: 32768 }, null)).toBe(true);
    expect(tooLongForLocal({ tokens: 30000, limit: 32768 }, 8192)).toBe(false);
    expect(tooLongForLocal({ tokens: 30000, window: 65536 }, 32768)).toBe(true);
  });

  it("is false whenever either side is unknown", () => {
    expect(tooLongForLocal(null, 32768)).toBe(false);
    expect(tooLongForLocal({ tokens: 100000 }, null)).toBe(false);
    expect(tooLongForLocal({ tokens: 100000 }, 0)).toBe(false);
    expect(tooLongForLocal({ tokens: 0 }, 32768)).toBe(false);
  });
});

describe("shortTokenCount", () => {
  it("names counts the way the card says them", () => {
    expect(shortTokenCount(100460)).toBe("100k");
    expect(shortTokenCount(32768)).toBe("32k");
    expect(shortTokenCount(65536)).toBe("65k");
    expect(shortTokenCount(850)).toBe("850");
    expect(shortTokenCount(0)).toBe("0");
    expect(shortTokenCount(Number.NaN)).toBe("0");
  });
});

describe("localTurnPhase", () => {
  const base = { compacting: false, serverReady: null, llamaCpp: true, heardFrom: false };

  it("says shortening while a compaction runs, whatever else is true", () => {
    expect(localTurnPhase({ ...base, compacting: true })).toBe("shortening");
    expect(localTurnPhase({ ...base, compacting: true, serverReady: false })).toBe("shortening");
    expect(localTurnPhase({ ...base, compacting: true, heardFrom: true })).toBe("shortening");
  });

  it("says loading only while llama-server answers that it is not ready", () => {
    expect(localTurnPhase({ ...base, serverReady: false })).toBe("loading");
    expect(localTurnPhase({ ...base, serverReady: true })).toBeNull();
    // Unknown is not "loading": that was the lie over a healthy server.
    expect(localTurnPhase({ ...base, serverReady: null })).toBeNull();
    expect(localTurnPhase({ ...base, serverReady: false, heardFrom: true })).toBeNull();
  });

  it("keeps the old words for a local model with no readiness probe (Ollama)", () => {
    expect(localTurnPhase({ ...base, llamaCpp: false })).toBe("loading");
    expect(localTurnPhase({ ...base, llamaCpp: false, heardFrom: true })).toBeNull();
  });
});

describe("compactionFramePhase", () => {
  it("reads the core's compaction frames", () => {
    expect(compactionFramePhase({ stream: "compaction", data: { phase: "start" } })).toBe("start");
    expect(compactionFramePhase({ stream: "compaction", data: { phase: "end", completed: true } })).toBe("end");
  });

  it("ignores every other frame", () => {
    expect(compactionFramePhase({ stream: "tool", data: { phase: "start" } })).toBeNull();
    expect(compactionFramePhase({ stream: "compaction", data: {} })).toBeNull();
    expect(compactionFramePhase({ stream: "compaction" })).toBeNull();
    expect(compactionFramePhase(null)).toBeNull();
    expect(compactionFramePhase("compaction")).toBeNull();
  });
});

it("bounds a local compaction at 90 seconds", () => {
  expect(LOCAL_COMPACTION_DEADLINE_MS).toBe(90_000);
});
