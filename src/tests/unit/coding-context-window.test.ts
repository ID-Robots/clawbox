/**
 * Reading a provider's context-length refusal, and deciding whether a run can
 * be carried on past it (TASK-2203, src/lib/coding-context-window.ts).
 */
import { describe, expect, it } from "vitest";
import {
  COMPACT_REQUEST_ROOM,
  MAX_CONTEXT_RECOVERIES,
  RECOVERY_DEFAULT_REPLY,
  RECOVERY_MAX_REPLY,
  RECOVERY_MIN_REPLY,
  contextOverflowError,
  contextRecoveryContinuation,
  parseContextOverflow,
  planContextRecovery,
} from "@/lib/coding-context-window";

/** The refusal exactly as the field run (an ultracode run, 1,697 turns in) reported it. */
const FIELD = "API Error: 400 This model's maximum context length is 1048576 tokens. However, you requested 1049351 tokens (1017351 in the messages, 32000 in the completion).";
/** What Claude Code 2.1.316 reports when its own compaction of that session was refused the same way. */
const COMPACTION_FAILED = "Prompt is too long · automatic compaction failed: API Error: 400 This model's maximum context length is 1048576 tokens. However, you requested 1051770 tokens (1019770 in the messages, 32000 in the completion). Please reduce the length of the messages or completion.";

describe("parseContextOverflow", () => {
  it("reads DeepSeek's refusal as the proxy passes it on: window, context and reply", () => {
    expect(parseContextOverflow(FIELD)).toEqual({ window: 1_048_576, context: 1_017_351, reply: 32_000, text: FIELD });
  });

  it("reads the same refusal inside Claude Code's failed-compaction line", () => {
    expect(parseContextOverflow(COMPACTION_FAILED)).toMatchObject({ window: 1_048_576, context: 1_019_770, reply: 32_000 });
  });

  it("leaves the context unknown when the refusal gives only the whole request", () => {
    // "you requested N" includes the reply, so N is not the context.
    expect(parseContextOverflow("This model's maximum context length is 131072 tokens. However, you requested 140000 tokens."))
      .toMatchObject({ window: 131_072, context: null, reply: null });
  });

  it("reads Anthropic's shape and Claude Code's bare one", () => {
    expect(parseContextOverflow("prompt is too long: 210000 tokens > 200000 maximum")).toMatchObject({ window: 200_000, context: 210_000 });
    expect(parseContextOverflow("Prompt is too long")).toMatchObject({ window: null, context: null });
    expect(parseContextOverflow('{"error":{"code":"context_length_exceeded"}}')).toMatchObject({ window: null });
  });

  it("is not fooled by a run merely talking about context windows", () => {
    for (const text of [
      "Done. I raised the context window setting to 1M tokens.",
      'API Error: 400 {"error":{"message":"Bad request","type":"invalid_request_error"}}',
      "",
      null,
      undefined,
    ]) {
      expect(parseContextOverflow(text), String(text)).toBeNull();
    }
  });

  it("keeps the provider's words bounded", () => {
    const long = `${FIELD} ${"x".repeat(5000)}`;
    expect(parseContextOverflow(long)?.text.length).toBeLessThanOrEqual(400);
  });
});

describe("planContextRecovery", () => {
  const field = parseContextOverflow(FIELD)!;

  it("carries the field run on with the largest reply that fits, capped at Claude Code's compaction reply", () => {
    // 1,048,576 − 1,017,351 − 4,096 = 27,129 → capped.
    expect(planContextRecovery(field, 0, true)).toEqual({ kind: "resume", maxReplyTokens: RECOVERY_MAX_REPLY, attempt: 1 });
  });

  it("asks for exactly the room left when that is less than the cap", () => {
    const tight = { ...field, context: 1_048_576 - COMPACT_REQUEST_ROOM - 9_000 };
    expect(planContextRecovery(tight, 1, true)).toEqual({ kind: "resume", maxReplyTokens: 9_000, attempt: 2 });
  });

  it("refuses when not even a summary fits beside the context", () => {
    const far = { ...field, context: 1_048_576 - COMPACT_REQUEST_ROOM - (RECOVERY_MIN_REPLY - 1) };
    expect(planContextRecovery(far, 0, true)).toEqual({ kind: "fail", reason: "no_room" });
    // A context already past the window.
    expect(planContextRecovery({ ...field, context: 1_100_000 }, 0, true)).toEqual({ kind: "fail", reason: "no_room" });
  });

  it("uses a modest default when the refusal named no numbers", () => {
    expect(planContextRecovery(parseContextOverflow("Prompt is too long")!, 0, true))
      .toEqual({ kind: "resume", maxReplyTokens: RECOVERY_DEFAULT_REPLY, attempt: 1 });
  });

  it("is bounded, and needs a session", () => {
    expect(planContextRecovery(field, MAX_CONTEXT_RECOVERIES, true)).toEqual({ kind: "fail", reason: "spent" });
    expect(planContextRecovery(field, 0, false)).toEqual({ kind: "fail", reason: "no_session" });
  });
});

describe("what the run and the owner are told", () => {
  const field = parseContextOverflow(FIELD)!;

  it("tells the resumed session to carry on, not start over, and where its evidence goes", () => {
    const text = contextRecoveryContinuation("/data/coding-agent-artifacts/run-x");
    expect(text).toContain("do not start over");
    expect(text).toContain("/data/coding-agent-artifacts/run-x");
  });

  it("gives the owner the real reason: the numbers, why it stopped, and the provider's words", () => {
    const spent = contextOverflowError(field, 2, "spent");
    expect(spent).toContain("(1,017,351 tokens of context plus 32,000 for the reply against a 1,048,576-token window)");
    expect(spent).toContain("carried it on 2 times");
    expect(spent).toContain(`The provider said: ${FIELD}`);
    expect(contextOverflowError(field, 1, "spent")).toContain("carried it on once");
    expect(contextOverflowError(field, 0, "no_room")).toContain("not even a summary of it fits");
    expect(contextOverflowError(parseContextOverflow("Prompt is too long")!, 0, "no_session"))
      .toMatch(/^The conversation outgrew the model's context window\. There was no session/);
  });
});
