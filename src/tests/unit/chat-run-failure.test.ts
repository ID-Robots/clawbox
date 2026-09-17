import { describe, expect, it } from "vitest";
import { describeChatFailure, describeFallbackReply } from "@/lib/chat-error-text";
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

/**
 * A turn that ended WELL on the configured fallback: the picked model failed
 * at the provider and another one answered. Frames captured verbatim on a box
 * (2026-09-17) — the ChatGPT lane's 401, then ClawBox AI Flash replying — with
 * the ids and the key fragment the provider echoed replaced.
 */
const AUTH_DETAIL =
  "unexpected status 401 Unauthorized: Incorrect API key provided: claw_08d*************************765e. You can find your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses, cf-ray: a3c7c040e8e4bc1a-SOF, request id: req_000000000000000000000000";

const fallbackStepToFlash = {
  runId: "run-fallback",
  sessionKey: SESSION,
  stream: "lifecycle",
  data: {
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "openai/gpt-6-astra",
    fallbackStepToModel: "deepseek/deepseek-v4-flash",
    fallbackStepFromFailureReason: "auth",
    fallbackStepFromFailureDetail: AUTH_DETAIL,
    fallbackStepChainPosition: 1,
    fallbackStepFinalOutcome: "candidate_succeeded",
  },
};

const fallbackSummary = {
  runId: "run-fallback",
  sessionKey: SESSION,
  stream: "lifecycle",
  data: {
    phase: "fallback",
    selectedProvider: "openai",
    selectedModel: "gpt-6-astra",
    activeProvider: "deepseek",
    activeModel: "deepseek-v4-flash",
    reasonSummary: "auth",
    attemptSummaries: ["openai/gpt-6-astra auth"],
    attempts: [{ provider: "openai", model: "gpt-6-astra", error: AUTH_DETAIL }],
  },
};

const finalFrame = { runId: "run-fallback", sessionKey: SESSION, state: "final", stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Hi." }], timestamp: 1 } };

describe("a reply another model wrote", () => {
  it("reads the served model off the fallback frames", () => {
    expect(runFailureFromAgentEvent(fallbackStepToFlash)?.context.servedModel).toBe("deepseek/deepseek-v4-flash");
    expect(runFailureFromAgentEvent(fallbackSummary)).toEqual({
      runId: "run-fallback",
      context: {
        provider: "openai",
        model: "gpt-6-astra",
        reason: "auth",
        detail: AUTH_DETAIL,
        servedProvider: "deepseek",
        servedModel: "deepseek-v4-flash",
      },
    });
  });

  it("says which model answered, why the picked one did not, and what to do — without the key fragment", () => {
    const ledger = new RunFailureLedger();
    ledger.observe(fallbackStepToFlash);
    ledger.observe(fallbackSummary);
    const note = describeFallbackReply(ledger.settle(finalFrame));
    expect(note).toBe(
      "This reply came from deepseek-v4-flash, not gpt-6-astra: OpenAI did not accept this box's sign-in for gpt-6-astra (“Incorrect API key provided”). Reconnect it in Settings, under Providers, to get gpt-6-astra back.",
    );
    expect(note).not.toMatch(/claw_|765e|platform\.openai\.com|cf-ray|request id/);
  });

  it("says nothing under a reply the picked model wrote itself", () => {
    const ledger = new RunFailureLedger();
    ledger.observe(finishing);
    expect(describeFallbackReply(ledger.settle({ runId: RUN, state: "final" }))).toBeUndefined();
    expect(describeFallbackReply({})).toBeUndefined();
  });

  it("words the other reasons a fallback can have", () => {
    expect(describeFallbackReply({ provider: "openai", model: "openai/gpt-6-astra", reason: "unknown", detail: "Explicit auth order for openai has no usable profiles.", servedModel: "deepseek/deepseek-v4-flash" })).toBe(
      "This reply came from deepseek-v4-flash, not gpt-6-astra: OpenAI rejected the request for gpt-6-astra (“Explicit auth order for openai has no usable profiles”). Pick another model in the header if it keeps happening.",
    );
    expect(describeFallbackReply({ provider: "anthropic", model: "claude-opus-5", reason: "rate_limit", servedModel: "deepseek-v4-flash" })).toBe(
      "This reply came from deepseek-v4-flash, not claude-opus-5: Anthropic is rate-limiting this box for claude-opus-5. It comes back on its own.",
    );
    expect(describeFallbackReply({ provider: "anthropic", model: "claude-x", reason: "model_not_found", servedModel: "deepseek-v4-flash" })).toBe(
      "This reply came from deepseek-v4-flash, not claude-x: Anthropic does not offer claude-x. Pick another model in the header.",
    );
  });
});

describe("the transport-field trim on a hostile detail", () => {
  it("stays linear on a hostile line whose TAIL cannot match (CodeQL js/redos)", () => {
    // The tail is the whole test. A line that ends in a well-formed field
    // (`",url:" + "\t,url:".repeat(20_000)`) matches the old regex
    // `(?:,\s*(?:url|cf-ray|request id)\s*:\s*[^,]*)+\s*$` greedily from index
    // 0 to the end and never backtracks — 2 ms on the OLD code, so a fixture
    // shaped like that is green on both sides of the fix and pins nothing.
    //
    // A tail the engine CANNOT match is what forces it through the ambiguous
    // `\s*` / `[^,]*` pairing. Measured on the old regex in node: 18 repeats
    // 27 ms, 20 → 99 ms, 22 → 393 ms, 24 → 1643 ms — doubling per repeat. The
    // split-and-pop is under a millisecond on the same 151 characters, so this
    // 500 ms budget is a factor of three under the old code and a factor of
    // hundreds over the new one.
    const hostile = ",url:" + "\t,url:".repeat(24) + ",x";
    const t0 = Date.now();
    const text = describeChatFailure("x", { reason: "format", provider: "anthropic", model: "m", detail: hostile });
    expect(Date.now() - t0).toBeLessThan(500);
    // …and the ANSWER is unchanged: no field is TRAILING here, so the trim
    // strips nothing and the hostile run survives into the sentence exactly as
    // the old regex left it (the colons go later, to the `:` -before-a-comma
    // rule this path has always had). Asserting it is what keeps this a speed
    // test rather than a quiet behaviour change.
    expect(text).toContain(",url,url");
  });

  it("still strips the real transport tail and keeps a comma inside the sentence", () => {
    expect(describeChatFailure("x", { reason: "format", provider: "openai", model: "m", detail: "unexpected status 400 Bad Request: One, two and three., url: https://api.example/v1, cf-ray: abc-XYZ, request id: req_0" }))
      .toBe("That message did not go through — OpenAI rejected the request for m: “One, two and three”. Pick another model in the header, or send it again.");
  });
});
