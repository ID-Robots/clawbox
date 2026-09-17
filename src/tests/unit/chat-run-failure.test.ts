import { describe, expect, it } from "vitest";
import { describeChatFailure } from "@/lib/chat-error-text";
import {
  RunFailureLedger,
  runFailureFromAgentEvent,
  runFailureFromChatError,
} from "@/lib/chat-run-failure";

/**
 * The frames below are what a box (core 2026.9.3) sent for one turn whose
 * model the provider rejected, captured verbatim over the gateway socket on
 * 2026-09-17; only the request id and the session ids were changed. The
 * provider's own words ride on the `fallback_step` frame and nowhere else.
 */
const RUN = "probe-1789642360884";
const SESSION = "agent:main:test";

const finishing = {
  runId: RUN,
  sessionKey: SESSION,
  sessionId: "00000000-0000-4000-8000-000000000001",
  agentId: "main",
  stream: "lifecycle",
  data: {
    phase: "finishing",
    error: "The selected model was not found by the provider. Check the model id or choose a different model.",
    errorObservation: {
      provider: "anthropic",
      model: "claude-nonexistent-9",
      failoverReason: "model_not_found",
      providerRuntimeFailureKind: "model_not_found",
    },
    aborted: false,
    livenessState: "blocked",
    endedAt: 1789642362605,
  },
  seq: 5,
  ts: 1789642362605,
  isHeartbeat: false,
};

const fallbackStep = {
  runId: RUN,
  sessionKey: SESSION,
  stream: "lifecycle",
  data: {
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "anthropic/claude-nonexistent-9",
    fallbackStepFromFailureReason: "model_not_found",
    fallbackStepFromFailureDetail:
      'HTTP 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-nonexistent-9"},"request_id":"req_000000000000000000000000"}',
    fallbackStepChainPosition: 1,
    fallbackStepFinalOutcome: "chain_exhausted",
  },
  sessionId: "00000000-0000-4000-8000-000000000001",
  agentId: "main",
  seq: 6,
  ts: 1789642362667,
  isHeartbeat: false,
};

const lifecycleError = {
  runId: RUN,
  sessionKey: SESSION,
  stream: "lifecycle",
  data: {
    aborted: false,
    livenessState: "blocked",
    errorObservation: {
      provider: "anthropic",
      model: "claude-nonexistent-9",
      failoverReason: "model_not_found",
      providerRuntimeFailureKind: "model_not_found",
    },
    phase: "error",
    endedAt: 1789642362691,
    startedAt: 1789642362112,
    error: "The selected model was not found by the provider. Check the model id or choose a different model.",
    executionSettled: true,
  },
  sessionId: "00000000-0000-4000-8000-000000000001",
  agentId: "main",
  seq: 7,
  ts: 1789642362691,
  isHeartbeat: false,
};

const chatError = {
  runId: RUN,
  sessionKey: SESSION,
  agentId: "main",
  seq: 7,
  state: "error",
  errorMessage: "The selected model was not found by the provider. Check the model id or choose a different model.",
  errorDetail: {
    provider: "anthropic",
    model: "claude-nonexistent-9",
    failoverReason: "model_not_found",
    providerRuntimeFailureKind: "model_not_found",
  },
};

/** The case the owner saw: a reason the gateway has no copy for → its generic sentence. */
const GENERIC_GATEWAY_SENTENCE = "The agent run failed before producing a reply.";
const versionRefusal = {
  ...fallbackStep,
  runId: "run-format",
  data: {
    ...fallbackStep.data,
    fallbackStepFromModel: "anthropic/claude-fable-5-1",
    fallbackStepFromFailureReason: "format",
    fallbackStepFromFailureDetail:
      'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required"},"request_id":"req_000000000000000000000000"}',
  },
};
const versionChatError = {
  runId: "run-format",
  sessionKey: SESSION,
  state: "error",
  errorMessage: GENERIC_GATEWAY_SENTENCE,
  errorDetail: { provider: "anthropic", model: "claude-fable-5-1", failoverReason: "format" },
};

describe("runFailureFromAgentEvent", () => {
  it("reads the provider, model and reason off a finishing or error frame", () => {
    expect(runFailureFromAgentEvent(finishing)).toEqual({
      runId: RUN,
      context: { provider: "anthropic", model: "claude-nonexistent-9", reason: "model_not_found" },
    });
    expect(runFailureFromAgentEvent(lifecycleError)?.context.reason).toBe("model_not_found");
  });

  it("reads the provider's raw refusal off the fallback_step frame", () => {
    expect(runFailureFromAgentEvent(fallbackStep)).toEqual({
      runId: RUN,
      context: {
        reason: "model_not_found",
        model: "anthropic/claude-nonexistent-9",
        detail: fallbackStep.data.fallbackStepFromFailureDetail,
      },
    });
  });

  it("ignores frames that say nothing about a failure", () => {
    expect(runFailureFromAgentEvent({ runId: RUN, stream: "tool", data: { name: "bash", phase: "start" } })).toBeNull();
    expect(runFailureFromAgentEvent({ runId: RUN, stream: "lifecycle", data: { phase: "start" } })).toBeNull();
    expect(runFailureFromAgentEvent({ runId: RUN, stream: "assistant", data: { delta: "hi" } })).toBeNull();
    expect(runFailureFromAgentEvent({ stream: "lifecycle", data: { phase: "error" } })).toBeNull();
    expect(runFailureFromAgentEvent(null)).toBeNull();
    expect(runFailureFromAgentEvent("nope")).toBeNull();
  });
});

describe("runFailureFromChatError", () => {
  it("reads errorDetail and nothing else", () => {
    expect(runFailureFromChatError(chatError)).toEqual({
      provider: "anthropic",
      model: "claude-nonexistent-9",
      reason: "model_not_found",
    });
    expect(runFailureFromChatError({ runId: RUN, state: "error", errorMessage: "x" })).toEqual({});
    expect(runFailureFromChatError(undefined)).toEqual({});
  });
});

describe("RunFailureLedger", () => {
  it("merges a run's frames and hands them over once, under the chat frame's own facts", () => {
    const ledger = new RunFailureLedger();
    ledger.observe(finishing);
    ledger.observe(fallbackStep);
    ledger.observe(lifecycleError);
    expect(ledger.settle(chatError)).toEqual({
      provider: "anthropic",
      model: "claude-nonexistent-9",
      reason: "model_not_found",
      detail: fallbackStep.data.fallbackStepFromFailureDetail,
    });
    // Consumed: the same run settles to the chat frame's facts alone.
    expect(ledger.settle(chatError)).toEqual({
      provider: "anthropic",
      model: "claude-nonexistent-9",
      reason: "model_not_found",
    });
  });

  it("keeps runs apart and forgets the oldest, so a run whose error never came cannot leak", () => {
    const ledger = new RunFailureLedger();
    for (let i = 0; i < 12; i++) {
      ledger.observe({ ...fallbackStep, runId: `run-${i}` });
    }
    expect(ledger.settle({ runId: "run-0", state: "error" })).toEqual({});
    expect(ledger.settle({ runId: "run-11", state: "error" }).detail).toBe(fallbackStep.data.fallbackStepFromFailureDetail);
    expect(ledger.settle({ runId: "run-5", state: "error" }).detail).toBe(fallbackStep.data.fallbackStepFromFailureDetail);
  });

  it("settles a chat frame with no run id to whatever it carries", () => {
    const ledger = new RunFailureLedger();
    expect(ledger.settle({ state: "error", errorMessage: "x" })).toEqual({});
  });
});

describe("describeChatFailure with the gateway's reason", () => {
  it("names the provider's refusal where the gateway's sentence was the generic one", () => {
    const ledger = new RunFailureLedger();
    ledger.observe(versionRefusal);
    const text = describeChatFailure(versionChatError.errorMessage, ledger.settle(versionChatError));
    expect(text).toBe(
      "That message did not go through — Anthropic rejected the request for claude-fable-5-1: “Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required”. Pick another model in the header, or send it again.",
    );
    expect(text).not.toContain("request_id");
    expect(text).not.toContain("{");
  });

  it("words a model the provider does not offer, and never the gateway's log advice", () => {
    const ledger = new RunFailureLedger();
    ledger.observe(finishing);
    ledger.observe(fallbackStep);
    ledger.observe(lifecycleError);
    expect(describeChatFailure(chatError.errorMessage, ledger.settle(chatError))).toBe(
      "That message did not go through — Anthropic does not offer the model this chat is set to (claude-nonexistent-9). Pick another model in the header and send it again.",
    );
    // The second `chat` error frame the gateway sends for the same run, with
    // the operator's `openclaw logs --follow` line, must not reach the bubble.
    const second = describeChatFailure(
      "⚠️ Agent failed before reply: The selected model was not found by the provider. Check the model id or choose a different model.\nTo view logs, run `openclaw logs --follow` in a terminal.",
      ledger.settle({ runId: RUN, state: "error" }),
    );
    expect(second).not.toContain("openclaw logs");
  });

  it("keeps the calm sentences for a rate limit or a refused credential when the reason says so", () => {
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, { reason: "rate_limit", provider: "anthropic" })).toMatch(/rate-limiting this box/);
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, { reason: "auth", provider: "anthropic" })).toMatch(/not accepting this box's sign-in/);
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, {
      reason: "unknown",
      detail: 'HTTP 429: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
    })).toMatch(/rate-limiting this box/);
  });

  it("words the other reasons the gateway classifies", () => {
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, { reason: "context_overflow", model: "openai/gpt-5" })).toBe(
      "That message did not go through — this conversation has grown too long for gpt-5. Start a New chat and send it there.",
    );
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, { reason: "overloaded", provider: "openai" })).toBe(
      "That message did not go through — OpenAI is having trouble right now. Nothing is broken on this box. Wait a minute and send it again.",
    );
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, {
      reason: "billing",
      provider: "clawai",
      detail: "HTTP 402: Your credits are exhausted",
    })).toBe(
      "That message did not go through — ClawBox AI reports a billing problem with this account: “Your credits are exhausted”. Check the account with ClawBox AI, or switch to a different provider in Settings.",
    );
  });

  it("falls back to the old rules when the context says nothing usable", () => {
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, {})).toBe(
      "That message did not go through. Send it again — the details stayed in this box's log.",
    );
    expect(describeChatFailure(GENERIC_GATEWAY_SENTENCE, { reason: "unclassified" })).toBe(
      "That message did not go through. Send it again — the details stayed in this box's log.",
    );
    expect(describeChatFailure("Request exceeds the size limit", { reason: "unknown" })).toBe("Error: Request exceeds the size limit");
  });

  it("never quotes a detail that fails the leak rules, and never a raw envelope", () => {
    const withPath = describeChatFailure(GENERIC_GATEWAY_SENTENCE, {
      reason: "format",
      provider: "anthropic",
      model: "claude-x",
      detail: 'HTTP 400: {"type":"error","error":{"message":"see /home/clawbox/.openclaw/agents/main/sessions/x.jsonl"}}',
    });
    expect(withPath).toBe(
      "That message did not go through — Anthropic rejected the request for claude-x. Pick another model in the header, or send it again.",
    );
    const notJson = describeChatFailure(GENERIC_GATEWAY_SENTENCE, {
      reason: "format",
      provider: "anthropic",
      detail: "HTTP 400: {\"type\":\"error\",\"error\":{\"message\":\"unterminated",
    });
    expect(notJson).not.toContain("{");
  });
});
